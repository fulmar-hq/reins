// The one config file: <private dir>/reins.config.json (see reins.config.example.json).
// With no file, every installed provider is on, nothing is sent, and no extra meters show.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export type ProviderName = "codex" | "claude";
/** `model` and `effort` are the everyday choice. `tiers` are named alternatives for other kinds of task ("hard", "review", "bulk"...):
 *  `run.ts --tier hard` picks one, and a tier named after a job kind is used for that kind when no tier is given. */
export type Tier = { model?: string; effort?: string };
export type ProviderConfig = { enabled: boolean; model?: string; effort?: string; tiers?: Record<string, Tier>; args?: string[]; trustedDir?: string };
export type Channel =
  | { channel: "none" }
  | { channel: "file"; file?: string }                // appended to; `bun wait.ts` returns when it grows
  | { channel: "command"; command: string[] }         // run with the summary and the body as two extra arguments
  | { channel: "telegram"; credentialsFile: string }; // private JSON file: {"botToken": "...", "chatId": "..."}
/** Any number you want on the page. `command` prints JSON: {"used": n} plus optional "forecast" and "limit" (or {"reason": "why unknown"}). */
export type ExtraMeter = { name: string; limit: number; unit?: string; reset: "monthly" | "weekly"; command: string[]; everyHours?: number };
export type Backlog = { label: string; command: string[]; everyMinutes: number };
/** A sign-in that lapses: `recordFile` holds the ISO time it was made; the owner is told 3 hours before `hours` are up. */
export type Expiry = { name: string; recordFile: string; hours: number; pausedFile?: string };
export type Config = {
  workRoots: string[]; disposableFolders: string[]; diskAlarmPercent: number;
  privateDir: string; timezone: string; defaultProvider: ProviderName; providers: Partial<Record<ProviderName, ProviderConfig>>;
  caps: { minutes: number; tokens: number; silentMinutes: number };
  notify: { live: boolean; owner: Channel; coordinator: Channel; unansweredMinutes: number; ownerMaxPerDay: number };
  extraMeters: ExtraMeter[]; backlog?: Backlog; expiries: Expiry[]; page: { port: number }; privacyTermsFile?: string;
};

const home = (path: string) => resolve(path.replace(/^~(?=\/|$)/, homedir()));
export const configPath = () => home(process.env.REINS_CONFIG ?? join(process.env.REINS_PRIVATE_DIR ?? "~/.reins", "reins.config.json"));

/** Defaults merged with the file. Throws a plain sentence when the file is wrong. */
export function loadConfig(path = configPath(), raw?: Record<string, any>): Config {
  path = home(path);
  if (!raw) try { raw = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {}; } catch (error) { throw Error(`${path} is not valid JSON: ${String(error)}`); }
  const r = raw!, installed = (["codex", "claude"] as const).filter(name => Bun.which(name));
  const providers: Config["providers"] = r.providers ?? Object.fromEntries(installed.map(name => [name, { enabled: true }]));
  const enabled = (Object.keys(providers) as ProviderName[]).filter(name => providers[name]?.enabled);
  for (const p of Object.values(providers)) if (p?.trustedDir) p.trustedDir = home(p.trustedDir);
  for (const name of Object.keys(providers)) if (name !== "codex" && name !== "claude") throw Error(`Unknown provider "${name}" in the config; use codex or claude.`);
  const timezone: string = r.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  try { new Intl.DateTimeFormat("en-US", { timeZone: timezone }); } catch { throw Error(`"${timezone}" is not a timezone name like America/Toronto.`); }
  const tilde = (part: string) => part.replace(/^~(?=\/)/, homedir());
  const channel = (c: any, role: string): Channel => {
    if (!c || c.channel === "none") return { channel: "none" };
    if (c.channel === "file") return { channel: "file", file: c.file && home(c.file) };
    if (c.channel === "command" && Array.isArray(c.command) && c.command.length) return { channel: "command", command: c.command.map(tilde) };
    if (c.channel === "telegram" && typeof c.credentialsFile === "string") return { channel: "telegram", credentialsFile: home(c.credentialsFile) };
    throw Error(`notify.${role} needs a channel of none, file, command (with "command") or telegram (with "credentialsFile").`);
  };
  const extraMeters: ExtraMeter[] = (r.extraMeters ?? []).map((m: any) => {
    if (typeof m.name !== "string" || !(m.limit > 0) || !["monthly", "weekly"].includes(m.reset) || !Array.isArray(m.command) || !m.command.length)
      throw Error('Each extra meter needs a name, a limit above zero, reset "monthly" or "weekly", and a command (a list of words).');
    return { ...m, command: m.command.map(tilde) };
  });
  let backlog: Backlog | undefined;
  if (r.backlog != null) {
    const { label = "backlog", command, everyMinutes = 60 } = r.backlog;
    if (typeof label !== "string" || !label.trim() || !Number.isFinite(everyMinutes) || everyMinutes <= 0
      || !Array.isArray(command) || !command.length || !command.every(part => typeof part === "string") || !command[0])
      throw Error("backlog needs a command (a list of words), an optional label, and a positive everyMinutes.");
    backlog = { label, command: command.map(tilde), everyMinutes };
  }
  const expiries: Expiry[] = (r.expiries ?? []).map((e: any) => {
    if (typeof e.name !== "string" || typeof e.recordFile !== "string" || !(e.hours > 0)) throw Error("Each expiry needs a name, a recordFile and hours.");
    return { ...e, recordFile: home(e.recordFile), pausedFile: e.pausedFile && home(e.pausedFile) };
  });
  if (r.defaultProvider && !enabled.includes(r.defaultProvider)) throw Error(`defaultProvider "${r.defaultProvider}" is not an enabled provider.`);
  const workRoots = r.workRoots ?? [], disposableFolders = r.disposableFolders ?? ["node_modules", ".next", ".turbo"];
  const dedicatedRoot = (p: unknown) => {
    if (typeof p !== "string" || !/^(\/|~\/)/.test(p) || p.split("/").includes("..") || p.includes("\0")) return false;
    const root = home(p);
    return root !== "/" && root !== homedir() && !homedir().startsWith(root + "/");
  };
  if (!Array.isArray(workRoots) || !workRoots.every(dedicatedRoot))
    throw Error("workRoots needs a list of absolute paths to dedicated job folders.");
  if (!Array.isArray(disposableFolders) || !disposableFolders.every(n => typeof n === "string" && n.trim() && ![".", "..", ".git"].includes(n) && !n.includes("/") && !n.includes("\0")))
    throw Error("disposableFolders needs plain folder names.");
  const diskAlarmPercent = r.diskAlarmPercent ?? 80;
  if (!Number.isFinite(diskAlarmPercent) || diskAlarmPercent <= 0 || diskAlarmPercent > 100)
    throw Error("diskAlarmPercent must be above zero and at most 100.");
  return {
    workRoots: [...new Set<string>(workRoots.map(home))], disposableFolders, diskAlarmPercent,
    privateDir: home(r.privateDir ?? dirname(path)), timezone,
    defaultProvider: r.defaultProvider ?? enabled[0] ?? "codex", providers,
    caps: { minutes: 60, tokens: 500_000, silentMinutes: 10, ...r.caps },
    notify: { live: r.notify?.live === true, owner: channel(r.notify?.owner, "owner"), coordinator: channel(r.notify?.coordinator ?? { channel: "file" }, "coordinator"),
      unansweredMinutes: r.notify?.unansweredMinutes ?? 30, ownerMaxPerDay: r.notify?.ownerMaxPerDay ?? 4 },
    extraMeters, backlog, expiries, page: { port: 4319, ...r.page }, privacyTermsFile: r.privacyTermsFile && home(r.privacyTermsFile),
  };
}
export const enabledProviders = (cfg: Config) => (Object.keys(cfg.providers) as ProviderName[]).filter(name => cfg.providers[name]?.enabled);
