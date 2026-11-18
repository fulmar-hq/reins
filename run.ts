#!/usr/bin/env bun
// Start one disposable job with the harness's own command, detached, and return at once. The watcher closes it.
// bun run.ts --kind build|review|fix|investigation|specialist --name "plain words" --cwd <dir> --prompt <file>
//   [--provider codex|claude] [--ticket id] [--retry-of <job id or run folder name>]
//   [--cap-tokens n] [--cap-minutes n] [--tier name] [--model m] [--effort e] [--dir <run folder>] [--print]
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync, writeSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { enabledProviders, loadConfig, type Config, type ProviderName } from "./config";
import { EXIT_NOTE, KINDS, appendLine, files, jobs, processStarted, purposeForKind, withLock, type Job, type Kind } from "./lib";
import { PROVIDERS } from "./providers";
import { moveTicketLocked, readTickets } from "./ticket";

export type Launch = {
  kind: Kind; name: string; cwd: string; prompt: string; provider?: ProviderName; ticket?: string; capTokens?: number; capMinutes?: number;
  tier?: string; model?: string; effort?: string; dir?: string; now?: number; retryOf?: string;
};
const verdictInstruction = 'The last line of your result must be exactly "VERDICT: DONE" if you achieved what you were asked to do, or "VERDICT: NOT DONE" if you did not.';

/** The exact command a launch would run, without running it. */
export function plan(cfg: Config, o: Launch, dir = "<run folder>") {
  const provider = o.provider ?? cfg.defaultProvider, settings = cfg.providers[provider];
  if (!enabledProviders(cfg).includes(provider)) throw Error(`${provider} is not enabled in the config (enabled: ${enabledProviders(cfg).join(", ") || "none"}).`);
  if (!KINDS.includes(o.kind)) throw Error(`--kind must be one of ${KINDS.join(", ")}`);
  if (o.retryOf !== undefined && (!o.ticket || !o.retryOf.trim() || o.retryOf.startsWith("--")))
    throw Error("--retry-of needs a job id or run folder name and --ticket.");
  if (!o.name?.trim()) throw Error("--name is required, in plain words");
  if (!existsSync(o.cwd) || !statSync(o.cwd).isDirectory()) throw Error(`--cwd is not a folder: ${o.cwd}`);
  if (!existsSync(o.prompt)) throw Error(`--prompt file not found: ${o.prompt}`);
  // Which model: an explicit --model/--effort, else the named tier, else a tier named after the kind, else the everyday default.
  const tiers = settings!.tiers ?? {};
  if (o.tier && !tiers[o.tier]) throw Error(`${provider} has no tier "${o.tier}" in the config (tiers: ${Object.keys(tiers).join(", ") || "none"}).`);
  const tier = tiers[o.tier ?? o.kind] ?? {}, model = o.model ?? tier.model ?? settings!.model, effort = o.effort ?? tier.effort ?? settings!.effort;
  const prompt = readFileSync(o.prompt, "utf8") + "\n\n" + verdictInstruction;
  const argv = PROVIDERS[provider].command({ ...settings!, model, effort, cwd: o.cwd, dir, prompt });
  return { provider, argv, prompt, model: model ?? null, effort: effort ?? null };
}
export async function launch(cfg: Config, o: Launch): Promise<Job> {
  plan(cfg, o); // refuse a bad request before creating anything
  const stage = o.kind === "build" || o.kind === "fix" ? "building" : o.kind === "review" ? "in review" : null;
  return o.ticket && stage
    ? withLock(files(cfg).lock, () => startJob(cfg, o, stage))
    : startJob(cfg, o, null);
}

function startJob(cfg: Config, o: Launch, stage: "building" | "in review" | null): Job {
  const f = files(cfg), now = new Date(o.now ?? Date.now());
  if (o.ticket && !readTickets(cfg).some(t => t.id === o.ticket)) throw Error(`There is no ticket ${o.ticket}; add it with ticket.ts first.`);
  let retryOf: string | null = null;
  if (o.retryOf) {
    const prior = jobs(f.ledger).filter(j => j.ticket === o.ticket);
    const matches = prior.filter(j => j.id === o.retryOf || basename(j.dir) === o.retryOf);
    if (matches.length !== 1) throw Error("--retry-of must identify one job on the same ticket.");
    retryOf = matches[0]!.id;
  }
  const stamp = now.toISOString().replace(/[-:]/g, "").slice(0, 15), day = stamp.slice(0, 8), time = stamp.slice(9);
  const slug = o.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "job";
  let dir = o.dir ? resolve(o.dir) : join(f.jobs, `${day}-${slug}`);
  if (!o.dir && existsSync(dir)) dir += `-${time}`;
  // A run folder is used once. Anything already there is someone's evidence: refuse, never overwrite.
  for (const name of ["prompt.txt", "log.txt", "result.txt", "job.json"]) if (existsSync(join(dir, name))) throw Error(`This run folder already holds a job (${name}); choose a new folder: ${dir}`);
  const { provider, argv, prompt, model, effort } = plan(cfg, o, dir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "prompt.txt"), prompt, { mode: 0o600, flag: "wx" });
  const log = openSync(join(dir, "log.txt"), "ax");
  // `detached` gives the job its own process group, which is what the watcher stops.
  const env = { ...process.env };
  delete env.REINS_PRIVATE_DIR;
  delete env.REINS_CONFIG;
  let child;
  try {
    child = Bun.spawn([process.execPath, "--no-env-file", import.meta.path, "--record-exit", process.env.REINS_FAKE_HARNESS ?? argv[0]!, ...argv.slice(1)], {
      cwd: resolve(o.cwd), env, detached: true, stdin: "ignore", stdout: log, stderr: log,
    });
  } finally { closeSync(log); }
  child.unref();
  const job: Job = {
    event: "started", id: `${day}-${time}-${slug}-${crypto.randomUUID().slice(0, 8)}`, name: o.name.trim(), kind: o.kind, provider, model, effort, ticket: o.ticket ?? null,
    started: now.toISOString(), ended: null, minutes: null, tokens: null, result: null, reason: null, dir, pid: child.pid, pidStarted: processStarted(child.pid),
    capMinutes: o.capMinutes ?? cfg.caps.minutes, capTokens: o.capTokens ?? cfg.caps.tokens,
  };
  writeFileSync(join(dir, "job.json"), JSON.stringify(job, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  Object.assign(job, { purpose: retryOf ? "retry" : purposeForKind(o.kind), retryOf, outcome: null });
  appendLine(f.ledger, job);
  if (o.ticket && stage) moveTicketLocked(cfg, o.ticket, stage, "launcher", now.getTime());
  return job;
}

if (import.meta.main && process.argv[2] === "--record-exit") {
  // Stay as group leader during a cap stop, so the watcher can still verify the group if it must escalate.
  process.on("SIGTERM", () => {});
  let status: number | "signal";
  try {
    const harness = Bun.spawn(process.argv.slice(3), { stdin: "ignore", stdout: "inherit", stderr: "inherit" });
    await harness.exited;
    status = harness.signalCode ? "signal" : harness.exitCode ?? "signal";
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    status = 127;
  }
  writeSync(1, `\n${EXIT_NOTE}${status}\n`);
  process.exit(typeof status === "number" ? status : 1);
} else if (import.meta.main) {
  const args = process.argv.slice(2), value = (flag: string) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
  const number = (flag: string) => { const v = value(flag); if (v === undefined) return; const n = Number(v); if (!Number.isFinite(n) || n <= 0) throw Error(`${flag} needs a positive number`); return n; };
  try {
    const cfg = loadConfig(), request: Launch = {
      kind: value("--kind") as Kind, name: value("--name") ?? "", cwd: value("--cwd") ?? "", prompt: value("--prompt") ?? "", provider: value("--provider") as ProviderName | undefined,
      ticket: value("--ticket"), retryOf: args.includes("--retry-of") ? value("--retry-of") ?? "" : undefined,
      capTokens: number("--cap-tokens"), capMinutes: number("--cap-minutes"), tier: value("--tier"), model: value("--model"), effort: value("--effort"), dir: value("--dir"),
    };
    if (args.includes("--print")) { const { provider, argv, prompt } = plan(cfg, request); console.log(`${provider}: ${argv.map(a => a === prompt ? "<prompt>" : /\s/.test(a) ? JSON.stringify(a) : a).join(" ")}`); }
    else console.log((await launch(cfg, request)).dir);
    process.exit(0);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
