#!/usr/bin/env bun
// Self-check: says in plain words what works and what is missing. Exits 1 when the setup is broken.
// It only sends a local test message and never signs in or starts a job.
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { configPath, enabledProviders, loadConfig, type Channel, type Config } from "./config";
import { files, percent, readLines, withLock, type Event } from "./lib";
import { newsHealth, send, takeNews } from "./notify";
import { PROVIDERS, installed } from "./providers";

let broken = 0;
console.log("Reins setup check");
const ok = (text: string) => console.log(`  ok       ${text}`);
const missing = (text: string) => { broken++; console.log(`  MISSING  ${text}`); };
const note = (text: string) => console.log(`  note     ${text}`);

let cfg: Config;
try { cfg = loadConfig(); } catch (error) { console.log(`  MISSING  The config file is wrong: ${error instanceof Error ? error.message : error}`); process.exit(1); }
existsSync(configPath()) ? ok(`Config file found: ${configPath()}`) : note(`No config file at ${configPath()}; using defaults (every installed tool, nothing sent).`);
try { mkdirSync(cfg.privateDir, { recursive: true }); accessSync(cfg.privateDir, constants.W_OK); ok(`Private folder is writable: ${cfg.privateDir}`); } catch { missing(`The private folder cannot be written: ${cfg.privateDir}`); }

const names = enabledProviders(cfg);
if (!names.length) missing("No tool is enabled. Install Codex or Claude Code, sign in yourself, and enable it under \"providers\" in the config.");
for (const name of names) {
  const p = PROVIDERS[name];
  if (!installed(name)) { missing(`${p.label} is enabled but the "${name}" command is not installed.`); continue; }
  if (!await p.signedIn()) { missing(`${p.label} is installed but not signed in. Sign in yourself with the tool's own login command; this check never does it for you.`); continue; }
  ok(`${p.label} is installed and signed in${name === cfg.defaultProvider ? " (default for new jobs)" : ""}.`);
  const usage = await p.usage(cfg.providers[name]!).catch(() => null);
  if (usage) ok(`${p.label} usage can be read: ${usage.windows.map(w => `${percent(w.used)} of ${w.name}`).join(", ")}.`);
  else note(`${p.label} usage could not be read; its meter will say "unknown".${name === "claude" ? " Open `claude` once in this project's folder and accept the trust question, and check python3 is installed." : ""}`);
}
for (const name of (["codex", "claude"] as const).filter(n => !names.includes(n))) note(`${PROVIDERS[name].label} is not enabled, so it is not shown anywhere.`);

const describe = (role: "owner" | "coordinator", c: Channel) => {
  if (c.channel === "none") return note(`No way to reach the ${role} is configured.`);
  if (c.channel === "file") return ok(`The ${role} is woken through a file; keep \`bun wait.ts\` running in the background of the coordinator chat.`);
  if (c.channel === "command") return Bun.which(c.command[0]!) || existsSync(c.command[0]!) ? ok(`The ${role} is reached with the command "${c.command[0]}".`) : missing(`The ${role} notification command "${c.command[0]}" does not exist.`);
  try {
    const secret = JSON.parse(readFileSync(c.credentialsFile, "utf8"));
    secret.botToken && secret.chatId ? ok(`The ${role} is reached on Telegram (credentials file found; not shown, not tested by sending).`) : missing(`The Telegram credentials file needs both "botToken" and "chatId".`);
  } catch { missing(`The Telegram credentials file for the ${role} is missing or not JSON: ${c.credentialsFile}`); }
};
describe("owner", cfg.notify.owner); describe("coordinator", cfg.notify.coordinator);
if (cfg.notify.coordinator.channel === "file") {
  try {
    const { wake, lock } = files(cfg), cursor = wake + ".delivered";
    withLock(lock, () => {
      for (const [path, mode] of [[wake, constants.R_OK | constants.W_OK], [cursor, constants.R_OK], [cursor + ".tmp", constants.W_OK]] as const) {
        if (!existsSync(path)) continue;
        if (!statSync(path).isFile()) throw Error(`${path} is not a file.`);
        accessSync(path, mode);
      }
    });
    // Use the wake file's directory, with a separate queue, cursor and events file.
    const privateDir = mkdtempSync(join(dirname(wake), ".wake-test-"));
    try {
      const probe: Config = { ...cfg, privateDir, notify: { ...cfg.notify, coordinator: { channel: "file" } } };
      const summary = "Doctor test message for the coordinator", body = "Testing the file wake and hand-over.";
      await send(probe, { to: "coordinator", summary, body }, cfg.notify.live);
      let received = "";
      if (!takeNews(probe, news => { received = news; }) || received.replace(/^--- [^\n]+\n/, "") !== `${summary}\n${body}\n`)
        throw Error("The hand-over did not return exactly the test message.");
    } finally { rmSync(privateDir, { recursive: true, force: true }); }
    ok("Coordinator wake test passed. The file hand-over returned the test message.");
  } catch (error) { missing(`Coordinator wake test failed. ${error instanceof Error ? error.message : error}`); }
} else note(`The coordinator wake was not tested for the "${cfg.notify.coordinator.channel}" channel.`);
note(cfg.notify.live ? "Sending is LIVE." : `Texts to the owner are off (dry-run). The coordinator wake is ${cfg.notify.coordinator.channel === "file" ? "on" : "off"}.`);
try {
  const events = files(cfg).events;
  if (existsSync(events)) accessSync(events, constants.W_OK);
  const { wakeWarning } = newsHealth(cfg, readLines<Event>(events), Date.now());
  if (wakeWarning) missing(process.stdout.isTTY && !process.env.NO_COLOR ? `\x1b[31m${wakeWarning}\x1b[0m` : wakeWarning);
} catch (error) { missing(`Could not check events.jsonl. ${error instanceof Error ? error.message : error}`); }
for (const m of cfg.extraMeters) Bun.which(m.command[0]!) || existsSync(m.command[0]!) ? ok(`Extra meter "${m.name}" has a command.`) : missing(`Extra meter "${m.name}": the command "${m.command[0]}" does not exist.`);

let state: any = null;
try { state = JSON.parse(readFileSync(files(cfg).state, "utf8")); } catch { /* never ran */ }
if (state && Date.now() - state.at < 3 * 60000) ok("The watcher ran in the last 3 minutes.");
else missing(state ? "The watcher has not run in the last 3 minutes. Is its LaunchAgent installed? (macOS launchd is the only scheduler supported so far.)" : "The watcher has never run. Install its LaunchAgent (see SETUP.md), or run `bun watch.ts --dry-run` once.");
const page = await fetch(`http://127.0.0.1:${cfg.page.port}/`, { signal: AbortSignal.timeout(3000) }).then(r => r.status, () => 0);
page === 200 || page === 503 ? ok(`The page answers on http://127.0.0.1:${cfg.page.port}`) : missing(`The page is not running on http://127.0.0.1:${cfg.page.port}. Install its LaunchAgent or run \`bun page.ts\`.`);
existsSync(`${cfg.privateDir}/tickets.json`) ? ok("tickets.json exists.") : note("No tickets yet. The coordinator adds them with `bun ticket.ts add`.");

console.log(broken ? `\n${broken} thing${broken > 1 ? "s" : ""} missing. Fix the MISSING lines above and run this again.` : "\nEverything needed is working.");
process.exit(broken ? 1 : 0);
