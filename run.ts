#!/usr/bin/env bun
// Start one disposable job with the harness's own command, detached, and return at once. The watcher closes it.
// bun run.ts --kind build|review|investigation|specialist --name "plain words" --cwd <dir> --prompt <file>
//   [--provider codex|claude] [--ticket id] [--cap-tokens n] [--cap-minutes n] [--model m] [--effort e] [--dir <run folder>] [--print]
import { spawn } from "node:child_process";
import { constants, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { enabledProviders, loadConfig, type Config, type ProviderName } from "./config";
import { KINDS, appendLine, files, processStarted, type Job, type Kind } from "./lib";
import { PROVIDERS } from "./providers";
import { moveTicket, readTickets } from "./ticket";

export type Launch = {
  kind: Kind; name: string; cwd: string; prompt: string; provider?: ProviderName; ticket?: string; capTokens?: number; capMinutes?: number;
  model?: string; effort?: string; dir?: string; now?: number;
};
/** The exact command a launch would run, without running it. */
export function plan(cfg: Config, o: Launch, dir = "<run folder>") {
  const provider = o.provider ?? cfg.defaultProvider, settings = cfg.providers[provider];
  if (!enabledProviders(cfg).includes(provider)) throw Error(`${provider} is not enabled in the config (enabled: ${enabledProviders(cfg).join(", ") || "none"}).`);
  if (!KINDS.includes(o.kind)) throw Error(`--kind must be one of ${KINDS.join(", ")}`);
  if (!o.name?.trim()) throw Error("--name is required, in plain words");
  if (!existsSync(o.cwd) || !statSync(o.cwd).isDirectory()) throw Error(`--cwd is not a folder: ${o.cwd}`);
  if (!existsSync(o.prompt)) throw Error(`--prompt file not found: ${o.prompt}`);
  const argv = PROVIDERS[provider].command({ ...settings!, model: o.model ?? settings!.model, effort: o.effort ?? settings!.effort, cwd: o.cwd, dir, prompt: readFileSync(o.prompt, "utf8") });
  return { provider, argv };
}
export async function launch(cfg: Config, o: Launch): Promise<Job> {
  plan(cfg, o); // refuse a bad request before creating anything
  const f = files(cfg), now = new Date(o.now ?? Date.now());
  if (o.ticket && !readTickets(cfg).some(t => t.id === o.ticket)) throw Error(`There is no ticket ${o.ticket}; add it with ticket.ts first.`);
  const stamp = now.toISOString().replace(/[-:]/g, "").slice(0, 15), day = stamp.slice(0, 8), time = stamp.slice(9);
  const slug = o.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "job";
  let dir = o.dir ? resolve(o.dir) : join(f.jobs, `${day}-${slug}`);
  if (!o.dir && existsSync(dir)) dir += `-${time}`;
  const prompt = join(dir, "prompt.txt");
  // A run folder is used once. Anything already there is someone's evidence: refuse, never overwrite.
  for (const name of ["prompt.txt", "log.txt", "result.txt", "job.json"]) if (existsSync(join(dir, name))) throw Error(`This run folder already holds a job (${name}); choose a new folder: ${dir}`);
  mkdirSync(dir, { recursive: true });
  copyFileSync(o.prompt, prompt, constants.COPYFILE_EXCL);
  const { provider, argv } = plan(cfg, { ...o, prompt }, dir), log = openSync(join(dir, "log.txt"), "ax");
  // `detached` gives the job its own process group, which is what the watcher stops.
  const child = spawn(process.env.SIMPLE_FACTORY_FAKE_HARNESS ?? argv[0]!, argv.slice(1), { cwd: resolve(o.cwd), detached: true, stdio: ["ignore", log, log] });
  await new Promise<void>((ok, fail) => { child.once("spawn", () => ok()); child.once("error", fail); });
  child.unref();
  const job: Job = {
    event: "started", id: `${day}-${time}-${slug}`, name: o.name.trim(), kind: o.kind, provider, ticket: o.ticket ?? null,
    started: now.toISOString(), ended: null, minutes: null, tokens: null, result: null, reason: null, dir, pid: child.pid!, pidStarted: processStarted(child.pid!),
    capMinutes: o.capMinutes ?? cfg.caps.minutes, capTokens: o.capTokens ?? cfg.caps.tokens,
  };
  writeFileSync(join(dir, "job.json"), JSON.stringify(job, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  appendLine(f.ledger, job);
  // A builder puts its ticket in "building" and a reviewer in "in review"; other kinds leave the stage alone.
  const stage = o.kind === "build" ? "building" : o.kind === "review" ? "in review" : null;
  if (o.ticket && stage) moveTicket(cfg, o.ticket, stage, "launcher", now.getTime());
  return job;
}

if (import.meta.main) {
  const args = process.argv.slice(2), value = (flag: string) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
  const number = (flag: string) => { const v = value(flag); if (v === undefined) return; const n = Number(v); if (!Number.isFinite(n) || n <= 0) throw Error(`${flag} needs a positive number`); return n; };
  try {
    const cfg = loadConfig(), request: Launch = {
      kind: value("--kind") as Kind, name: value("--name") ?? "", cwd: value("--cwd") ?? "", prompt: value("--prompt") ?? "", provider: value("--provider") as ProviderName | undefined,
      ticket: value("--ticket"), capTokens: number("--cap-tokens"), capMinutes: number("--cap-minutes"), model: value("--model"), effort: value("--effort"), dir: value("--dir"),
    };
    if (args.includes("--print")) { const { provider, argv } = plan(cfg, request); const text = readFileSync(request.prompt, "utf8"); console.log(`${provider}: ${argv.map(a => a === text ? "<prompt>" : /\s/.test(a) ? JSON.stringify(a) : a).join(" ")}`); }
    else console.log((await launch(cfg, request)).dir);
    process.exit(0);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
