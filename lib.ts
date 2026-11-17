// Shared plain-file helpers for the simple factory. No model call anywhere in this project.
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, rmdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Config, ProviderName } from "./config";

export const KINDS = ["build", "review", "investigation", "specialist"] as const;
export type Kind = (typeof KINDS)[number];
/** ended-unconfirmed: the job's process could not be confirmed as ours, so nothing was signalled. */
export type Result = "finished" | "stopped-cap" | "stopped-silent" | "failed" | "ended-unconfirmed";
/** Real counts only, null when not knowable. `fresh` = input - cached + output, the part that is not a cache re-read. */
export type Tokens = { input: number | null; cached: number | null; output: number | null; fresh: number | null };
export type Job = {
  event: "started" | "ended"; id: string; name: string; kind: Kind; provider: ProviderName; model?: string | null; effort?: string | null; ticket: string | null;
  started: string; ended: string | null; minutes: number | null; tokens: Tokens | null;
  result: Result | null; reason: string | null; dir: string; pid: number; pidStarted: string; capMinutes: number; capTokens: number;
};
export type Ask = { question: string; recommendation: string; reason: string; fallback: { at: number; action: string } | null };
export type Event = { key: string; at: string; type: string; text: string; dir?: string; ask?: Ask; askId?: string;
  ticket?: string; stage?: string;
  /** quiet: the coordinator's own action, recorded but never sent back to it. held: an owner text stopped by the daily limit. */
  quiet?: boolean; held?: boolean };

export const files = (cfg: Config) => ({
  ledger: join(cfg.privateDir, "ledger.jsonl"), events: join(cfg.privateDir, "events.jsonl"), state: join(cfg.privateDir, "state.json"),
  stateOfPlay: join(cfg.privateDir, "state-of-play.md"), jobs: join(cfg.privateDir, "work/jobs"), lock: join(cfg.privateDir, "write.lock"),
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
type Row = { pid: number; pgid: number; started: string };
const processes = (): Row[] => Bun.spawnSync(["ps", "-A", "-o", "pid=,pgid=,stat=,lstart="]).stdout.toString().split("\n").flatMap(line => {
  const [pid, pgid, stat = "", ...started] = line.trim().split(/\s+/);
  return pid && !stat.startsWith("Z") ? [{ pid: Number(pid), pgid: Number(pgid), started: started.join(" ") }] : []; // a finished, unreaped process is not alive
});
/** When the live process with this pid started, as `ps` prints it; "" when there is none. */
export const processStarted = (pid: number) => processes().find(p => p.pid === pid)?.started ?? "";
/** True only when the recorded process itself is alive: same pid, same recorded start time, still leading its own group.
 *  This is the only condition under which a job may be signalled. Leftover children of a leader that has gone are never
 *  enough, because nothing then proves the group is still ours. */
export function isOurLeader(pid: number, started: string): boolean {
  const same = processes().find(p => p.pid === pid);
  return Boolean(same) && started !== "" && same!.started === started && same!.pgid === pid;
}
/** Run `work` while holding an exclusive lock folder, so check-then-write on shared files has one writer at a time.
 *  Every path is bounded by `timeoutMs`; when the lock cannot be taken in time this throws and nothing is done. */
export function withLock<T>(path: string, work: () => T, timeoutMs = 5000): T {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { mkdirSync(dirname(path), { recursive: true }); mkdirSync(path); break; } catch { /* held by someone else, or not creatable */ }
    if (Date.now() - mtime(path) > 30000) try { rmdirSync(path); continue; } catch { /* a stale lock that cannot be removed: keep to the deadline */ }
    if (Date.now() >= deadline) throw Error(`Could not take the lock ${path} within ${Math.round(timeoutMs / 1000)} seconds; nothing was done.`);
    Bun.sleepSync(25);
  }
  try { return work(); } finally { try { rmdirSync(path); } catch { /* already cleared */ } }
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
