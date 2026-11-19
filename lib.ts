// Shared plain-file helpers for Reins. No model call anywhere in this project.
import { appendFileSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Config, ProviderName } from "./config";

export const KINDS = ["build", "review", "fix", "investigation", "specialist"] as const;
export type Kind = (typeof KINDS)[number];
export type Purpose = "build" | "review" | "fix" | "retry";
export type Outcome = "finished" | "stopped" | "capped" | "failed";
export const purposeForKind = (kind: Kind): Purpose => kind === "review" || kind === "fix" ? kind : "build";
export const NO_RESULT = "the job ended without a result";
export const EXIT_NOTE = "Reins harness exit: ";
/** ended-unconfirmed: the job's process could not be confirmed as ours, so nothing was signalled. */
export type Result = "finished" | "stopped-cap" | "stopped-silent" | "stopped" | "failed" | "ended-unconfirmed";
/** Real counts only, null when not knowable. `fresh` = input - cached + output, the part that is not a cache re-read. */
export type Tokens = { input: number | null; cached: number | null; output: number | null; fresh: number | null };
export type Job = {
  event: "started" | "ended"; id: string; name: string; kind: Kind; provider: ProviderName; model?: string | null; effort?: string | null; ticket: string | null;
  started: string; ended: string | null; minutes: number | null; tokens: Tokens | null;
  purpose?: Purpose; retryOf?: string | null; outcome?: Outcome | null; achieved?: boolean | null;
  cwd?: import("./tidy").Folder | null; ownedFolders?: import("./tidy").Folder[];
  reasonKind?: "redirected";
  result: Result | null; reason: string | null; dir: string; pid: number; pidStarted: string; capMinutes: number; capTokens: number;
};
export type Ask = { question: string; recommendation: string; reason: string; fallback: { at: number; action: string } | null };
export type Event = { key: string; at: string; type: string; text: string; dir?: string; ask?: Ask; askId?: string;
  ticket?: string; stage?: string; previousTitle?: string;
  /** quiet: the coordinator's own action, recorded but never sent back to it. held: an owner text stopped by the daily limit. */
  quiet?: boolean; held?: boolean };

export const files = (cfg: Config) => ({
  ledger: join(cfg.privateDir, "ledger.jsonl"), events: join(cfg.privateDir, "events.jsonl"), state: join(cfg.privateDir, "state.json"),
  stateOfPlay: join(cfg.privateDir, "state-of-play.md"), jobs: join(cfg.privateDir, "work/jobs"), lock: join(cfg.privateDir, "write.lock"),
  passLock: join(cfg.privateDir, "watch.lock"),
  wake: cfg.notify.coordinator.channel === "file" && cfg.notify.coordinator.file || join(cfg.privateDir, "wake.txt"),
});

export function readLines<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  const out: T[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* a torn line is skipped, never guessed */ }
  }
  return out;
}
export const appendLine = (path: string, value: unknown) => appendFileSync(path, JSON.stringify(value) + "\n", { mode: 0o600 });
/** The ledger is append-only; the last line for an id is that job's current truth. */
export function jobs(ledger: string): Job[] {
  const byId = new Map<string, Job>();
  for (const line of readLines<Job>(ledger)) if (line?.id) byId.set(line.id, line);
  return [...byId.values()];
}

export function ticketAttempts(id: string, ledger: readonly Job[]) {
  return ledger.filter(j => j.ticket === id).sort((a, b) => Date.parse(a.started) - Date.parse(b.started)).map(j => ({
    id: j.id, name: j.name, purpose: j.purpose ?? purposeForKind(j.kind), retryOf: j.retryOf ?? null,
    started: j.started, ended: j.ended, minutes: j.minutes, tokens: j.tokens,
    outcome: jobOutcome(j),
    achieved: j.achieved,
    why: j.reason,
    reasonKind: j.reasonKind,
  }));
}

export function jobOutcome(j: Job): Outcome | null {
  if (j.event !== "ended") return null;
  if (j.outcome) return j.outcome;
  if (j.result === "finished") return "finished";
  if (j.result === "stopped-cap") return "capped";
  return j.result === "failed" && j.reason !== NO_RESULT ? "failed" : "stopped";
}

export const mtime = (path: string) => { try { return statSync(path).mtimeMs; } catch { return 0; } };
export function slice(path: string, bytes: number, from: "start" | "end"): string {
  const size = statSync(path).size, length = Math.min(size, bytes), buffer = Buffer.alloc(length), fd = openSync(path, "r");
  try { readSync(fd, buffer, 0, length, from === "start" ? 0 : size - length); } finally { closeSync(fd); }
  return buffer.toString("utf8");
}
/** Run a command without a shell; resolves with its output, rejects on a non-zero exit or the timeout. */
export async function exec(argv: string[], options: { cwd?: string; timeoutMs?: number } = {}): Promise<string> {
  const child = Bun.spawn(argv, { cwd: options.cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: options.timeoutMs ?? 30000 });
  const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  if (code !== 0) throw Error(`${argv[0]} exited ${code}`);
  return out;
}
type Row = { pid: number; pgid: number; stat: string; started: string };
const processes = (env = process.env): Row[] => Bun.spawnSync(["ps", "-A", "-o", "pid=,pgid=,stat=,lstart="], { env }).stdout.toString().split("\n").flatMap(line => {
  const [pid, pgid, stat = "", ...started] = line.trim().split(/\s+/);
  return pid ? [{ pid: Number(pid), pgid: Number(pgid), stat, started: started.join(" ") }] : [];
});
const liveProcess = (pid: number) => processes().find(p => p.pid === pid && !p.stat.startsWith("Z"));
/** When the live process with this pid started, as `ps` prints it; "" when there is none. */
export const processStarted = (pid: number) => liveProcess(pid)?.started ?? "";
/** True only when the recorded process itself is alive: same pid, same recorded start time, still leading its own group.
 *  This is the only condition under which a job may be signalled. Leftover children of a leader that has gone are never
 *  enough, because nothing then proves the group is still ours. */
export function isOurLeader(pid: number, started: string): boolean {
  const same = liveProcess(pid);
  return Boolean(same) && started !== "" && same!.started === started && same!.pgid === pid;
}
const lockProcesses = () => processes({ ...process.env, TZ: "UTC", LC_ALL: "C" });
const lockStartPrefix = "UTC:";
let lockOwnerStarted: string | undefined;

function clearDeadLock(path: string) {
  try {
    const entries = readdirSync(path), owner = entries.length === 1 && entries[0]!;
    const match = owner && /^owner-([1-9]\d*)-[a-zA-Z0-9]+$/.exec(owner);
    if (match && owner) {
      const pid = Number(match[1]), marker = join(path, owner);
      if (pid === process.pid) return;
      const started = readFileSync(marker, "utf8");
      let dead = false;
      try { process.kill(pid, 0); } catch (error) { dead = (error as NodeJS.ErrnoException).code === "ESRCH"; }
      if (!dead) {
        const current = lockProcesses().find(p => p.pid === pid);
        // Older markers used local time, so their timestamps cannot prove that a live PID was reused.
        dead = !!current && (current.stat.startsWith("Z")
          || started.startsWith(lockStartPrefix) && current.started !== "" && lockStartPrefix + current.started !== started);
      }
      if (!dead) return;
      // Only the contender that removes this owner's unique marker may clear its folder.
      unlinkSync(marker);
    } else if (entries.length || Date.now() - mtime(path) <= 30000) return;
    rmdirSync(path);
  } catch { /* The folder changed while we inspected it, or could not be cleared. */ }
}

/** Try to take a lock once, recovering a dead owner's lock along the way. */
export function tryLock(path: string): (() => void) | undefined {
  mkdirSync(dirname(path), { recursive: true });
  clearDeadLock(path);
  if (existsSync(path)) return;
  const pending = mkdtempSync(join(dirname(path), `owner-${process.pid}-`)), owner = basename(pending);
  const marker = join(pending, owner);
  try {
    // Publish a populated folder atomically. A concurrent owner's nonempty folder cannot be replaced.
    lockOwnerStarted ??= lockProcesses().find(p => p.pid === process.pid)?.started ?? "";
    writeFileSync(marker, lockOwnerStarted ? lockStartPrefix + lockOwnerStarted : "");
    renameSync(pending, path);
  } catch (error) {
    if (existsSync(marker)) unlinkSync(marker);
    rmdirSync(pending);
    if (["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) return;
    throw error;
  }
  return () => {
    try { unlinkSync(join(path, owner)); } catch (error) {
      // Our marker can be gone if the lock folder was removed or moved.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    try { rmdirSync(path); } catch (error) {
      // Another contender may already have replaced the now-empty folder.
      if (!["ENOENT", "EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
  };
}

/** Run synchronous work under the shared write lock, waiting at most `timeoutMs` to take it. */
export function withLock<T>(path: string, work: () => T, timeoutMs = 5000): T {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const release = tryLock(path);
    if (release) try { return work(); } finally { release(); }
    if (Date.now() >= deadline) throw Error(`Could not take the lock ${path} within ${Math.round(timeoutMs / 1000)} seconds; nothing was done.`);
    Bun.sleepSync(25);
  }
}

export type Pace = { verdict: "plenty left" | "on track" | "too fast"; runsOutAt: number | null };
/** The one place pace is computed. `used` is a share of the limit. Without a forecast it assumes steady use from the
 *  window start to `at`, carried to the reset; with one (the source's own end-of-window share) the forecast decides.
 *  In the first twentieth of a window a straight line from so little time is noise, so it never says "too fast" there. */
export function pace(used: number, start: number, reset: number, at: number, forecast?: number): Pace {
  if (used >= 1) return { verdict: "too fast", runsOutAt: at };
  const elapsed = at - start, span = reset - start, steady = elapsed > 0 && used > 0 ? start + elapsed / used : Infinity;
  const runsOutAt = steady < reset ? Math.round(steady) : null;
  if (forecast !== undefined) return forecast > 1 ? { verdict: "too fast", runsOutAt } : { verdict: forecast <= 0.75 ? "plenty left" : "on track", runsOutAt: null };
  if (span <= 0 || elapsed < span / 20) return { verdict: "on track", runsOutAt: null };
  if (runsOutAt !== null) return { verdict: "too fast", runsOutAt };
  return { verdict: used * span / elapsed <= 0.75 ? "plenty left" : "on track", runsOutAt: null };
}

/** Times in the configured timezone: "Wed, Nov 18, 7:41 AM EST", calendar day, hour, and that day's midnight. */
export function clock(timeZone: string) {
  const parts = (ms: number) => Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(ms).map(p => [p.type, p.value]));
  return {
    at: (ms: number) => new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(ms),
    day: (ms: number) => { const p = parts(ms); return `${p.year}-${p.month}-${p.day}`; },
    hour: (ms: number) => Number(parts(ms).hour),
    dayStart: (ms: number) => { const p = parts(ms); return ms - (ms % 1000) - ((Number(p.hour) * 60 + Number(p.minute)) * 60 + Number(p.second)) * 1000; },
  };
}
export const count = (n: number | null | undefined) => n == null ? "unknown" : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}K` : String(n);
export const percent = (used: number) => `${Math.round(used * 100)}%`;
