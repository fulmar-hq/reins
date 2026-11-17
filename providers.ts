// One small adapter per harness. Reins only starts the harness's own official command under
// the user's existing sign-in, then reads what the harness itself wrote. No API keys, no model calls.
import { spawn } from "node:child_process";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ProviderConfig, ProviderName } from "./config";
import { exec, mtime, slice, type Tokens } from "./lib";

export type Usage = { observedAt: number; windows: { name: string; used: number; resetsAt: number; minutes: number | null }[] };
export type Provider = {
  name: ProviderName; label: string;
  /** The official command that runs one job. Its output goes to log.txt in the run folder. */
  command(o: { cwd: string; dir: string; prompt: string } & ProviderConfig): string[];
  /** True once the job's final answer is in result.txt (written by the harness, or copied here from its log). */
  finished(dir: string): boolean;
  /** Token counts so far and the last sign of life, from the harness's own records. */
  facts(dir: string, startedMs: number): { tokens: Tokens | null; lastGrowth: number };
  /** Subscription usage and reset times as the harness reports them; null when it cannot be read. */
  usage(config: ProviderConfig): Promise<Usage | null>;
  signedIn(): Promise<boolean>;
  /** Fresh tokens today in this harness's sessions that are not launched jobs, where that can be measured. */
  otherTokensToday?(dayStartMs: number, jobDirs: string[]): number;
};
const hasResult = (dir: string) => { try { return statSync(join(dir, "result.txt")).size > 0; } catch { return false; } };
const tokens = (input: number, cached: number, output: number): Tokens => ({ input, cached, output, fresh: input - cached + output });
const whole = (...values: unknown[]) => values.every(n => Number.isSafeInteger(n) && (n as number) >= 0);

// ---- Codex ----
const codexSessions = () => process.env.CODEX_SESSIONS_DIR ?? join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "sessions");
const dayDir = (ms: number) => { const d = new Date(ms); return join(codexSessions(), String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0")); };
/** Last cumulative count (and rate limits) Codex wrote to one of its own session files. */
function codexFile(path: string): { tokens: Tokens; limits: any; at: number } | null {
  for (const bytes of [65536, 1048576]) {
    let lines: string[];
    try { lines = slice(path, bytes, "end").split("\n").filter(line => line.includes('"token_count"')); } catch { return null; }
    for (const line of lines.reverse()) try {
      const x = JSON.parse(line), u = x.payload?.info?.total_token_usage;
      if (whole(u?.input_tokens, u?.cached_input_tokens, u?.output_tokens))
        return { tokens: tokens(u.input_tokens, u.cached_input_tokens, u.output_tokens), limits: x.payload.rate_limits, at: Date.parse(x.timestamp) };
    } catch { /* the cut-off first line of the slice */ }
  }
  return null;
}
const codexSessionId = (dir: string) => { try { return slice(join(dir, "log.txt"), 4096, "start").match(/^session id: ([0-9a-f-]{36})$/m)?.[1] ?? null; } catch { return null; } };
function codexSessionFile(dir: string, startedMs: number): string | null {
  const id = codexSessionId(dir);
  for (const offset of id ? [0, 1, -1] : []) {
    const day = dayDir(startedMs + offset * 86400000);
    try { for (const name of readdirSync(day)) if (name.endsWith(`${id}.jsonl`)) return join(day, name); } catch { /* no such day */ }
  }
  return null;
}
const codexWindows = (limits: any, seconds: boolean): Usage["windows"] => ["primary", "secondary"].flatMap(key => {
  const w = limits?.[key], used = w?.used_percent ?? w?.usedPercent, reset = w?.resets_at ?? w?.resetsAt;
  return Number.isFinite(used) && Number.isFinite(reset) ? [{ name: key, used: used / 100, resetsAt: seconds ? reset * 1000 : reset, minutes: w.window_minutes ?? w.windowDurationMins ?? null }] : [];
});
/** Ask the installed Codex for its rate limits over its own app-server protocol: no thread, no model turn. */
function codexLive(timeoutMs = 8000): Promise<Usage | null> {
  return new Promise(done => {
    const child = spawn("codex", ["app-server", "--stdio"], { stdio: ["pipe", "pipe", "ignore"] });
    let pending = "";
    const finish = (usage: Usage | null) => { clearTimeout(timer); child.kill("SIGKILL"); done(usage); };
    const timer = setTimeout(() => finish(null), timeoutMs), send = (message: unknown) => child.stdin.write(JSON.stringify(message) + "\n");
    child.on("error", () => finish(null)); child.on("exit", () => finish(null)); child.stdin.on("error", () => finish(null));
    child.stdout.on("data", (chunk: Buffer) => {
      pending += chunk.toString("utf8");
      for (let end; (end = pending.indexOf("\n")) >= 0; pending = pending.slice(end + 1)) try {
        const response = JSON.parse(pending.slice(0, end));
        if (response.id === 1) { send({ method: "initialized" }); send({ id: 2, method: "account/rateLimits/read", params: { excludeResetCreditDetails: true } }); }
        if (response.id === 2) {
          const limits = response.result?.rateLimitsByLimitId?.codex ?? response.result?.rateLimits, windows = codexWindows(limits, true);
          return finish(windows.length ? { observedAt: Date.now(), windows } : null);
        }
      } catch { /* not a JSON line */ }
    });
    send({ id: 1, method: "initialize", params: { clientInfo: { name: "reins_usage", version: "0.2.0" }, capabilities: null } });
  });
}
const codex: Provider = {
  name: "codex", label: "Codex",
  command: o => ["codex", "exec", "-C", resolve(o.cwd), ...(o.model ? ["-m", o.model] : []), ...(o.effort ? ["-c", `model_reasoning_effort=${o.effort}`] : []),
    ...(o.args ?? []), "-o", join(o.dir, "result.txt"), o.prompt],
  finished: hasResult,
  facts(dir, startedMs) {
    const file = codexSessionFile(dir, startedMs);
    let found = file ? codexFile(file)?.tokens ?? null : null;
    if (!found) try { // Codex also prints one total at the end of its log
      const printed = slice(join(dir, "log.txt"), 65536, "end").match(/\ntokens used\n([\d,]+)/)?.[1];
      if (printed) found = { input: null, cached: null, output: null, fresh: Number(printed.replaceAll(",", "")) };
    } catch { /* no log yet */ }
    return { tokens: found, lastGrowth: Math.max(mtime(join(dir, "log.txt")), file ? mtime(file) : 0, startedMs) };
  },
  async usage() {
    const live = await codexLive();
    if (live) return live;
    // Fallback: the newest rate-limit note Codex left in a recent session file.
    const recent = [0, -1].flatMap(d => { const day = dayDir(Date.now() + d * 86400000); try { return readdirSync(day).map(n => join(day, n)); } catch { return []; } })
      .sort((a, b) => mtime(b) - mtime(a)).slice(0, 5);
    for (const path of recent) { const f = codexFile(path), windows = codexWindows(f?.limits, true); if (f && windows.length) return { observedAt: f.at, windows }; }
    return null;
  },
  signedIn: () => exec(["codex", "login", "status"], { timeoutMs: 15000 }).then(() => true, () => false),
  otherTokensToday(dayStartMs, jobDirs) {
    const owned = new Set(jobDirs.map(codexSessionId));
    let total = 0;
    for (const day of [dayDir(dayStartMs + 43200000), dayDir(dayStartMs - 43200000)]) {
      let names: string[] = [];
      try { names = readdirSync(day); } catch { continue; }
      for (const name of names) {
        const path = join(day, name);
        if (name.endsWith(".jsonl") && mtime(path) >= dayStartMs && !owned.has(name.slice(-42, -6))) total += codexFile(path)?.tokens.fresh ?? 0;
      }
    }
    return total;
  },
};

// ---- Claude Code ----
/** `claude -p --output-format stream-json` writes one JSON line per step; the last "result" line holds the answer and totals. */
function claudeLog(dir: string): { result: string | null; tokens: Tokens | null } {
  const perMessage = new Map<string, Tokens>();
  let text: string;
  try { text = readFileSync(join(dir, "log.txt"), "utf8"); } catch { return { result: null, tokens: null }; }
  const count = (u: any) => whole(u?.input_tokens, u?.output_tokens) ? tokens(u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), u.cache_read_input_tokens ?? 0, u.output_tokens) : null;
  for (const line of text.split("\n")) {
    if (!line.startsWith("{")) continue;
    try {
      const x = JSON.parse(line);
      if (x.type === "result") return { result: x.is_error ? null : String(x.result ?? ""), tokens: count(x.usage) };
      const usage = x.type === "assistant" && x.message?.id ? count(x.message.usage) : null;
      if (usage) perMessage.set(x.message.id, usage);
    } catch { /* a line still being written */ }
  }
  const all = [...perMessage.values()], sum = (key: keyof Tokens) => all.reduce((n, t) => n + (t[key] ?? 0), 0);
  return { result: null, tokens: all.length ? tokens(sum("input"), sum("cached"), sum("output")) : null };
}
const claude: Provider = {
  name: "claude", label: "Claude",
  command: o => ["claude", "-p", o.prompt, "--output-format", "stream-json", "--verbose", ...(o.model ? ["--model", o.model] : []), ...(o.effort ? ["--effort", o.effort] : []), ...(o.args ?? [])],
  finished(dir) {
    if (hasResult(dir)) return true;
    const { result } = claudeLog(dir);
    if (!result) return false;
    writeFileSync(join(dir, "result.txt"), result + "\n");
    return true;
  },
  facts: (dir, startedMs) => ({ tokens: claudeLog(dir).tokens, lastGrowth: Math.max(mtime(join(dir, "log.txt")), startedMs) }),
  // Claude Code shows its limits only in its own /usage panel; claude-usage.py opens that panel and reads it.
  usage: config => exec(["/usr/bin/env", "python3", "-I", "-B", join(import.meta.dir, "claude-usage.py")], { cwd: config.trustedDir ?? import.meta.dir, timeoutMs: 20000 })
    .then(out => { const u = JSON.parse(out) as Usage | null; return u?.windows?.length ? u : null; }, () => null),
  signedIn: () => exec(["claude", "auth", "status"], { timeoutMs: 15000 }).then(out => JSON.parse(out).loggedIn === true, () => false),
};

export const PROVIDERS: Record<ProviderName, Provider> = { codex, claude };
export const installed = (name: ProviderName) => Boolean(Bun.which(name));
