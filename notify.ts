// Notifications behind one small function. Dry-run sends nothing outside this machine: the coordinator's own
// wake file is still written, because a job that finishes unnoticed is the failure this project exists to prevent.
import { appendFileSync, closeSync, fstatSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from "node:fs";
import type { Channel, Config } from "./config";
import { appendLine, files, readLines, withLock, type Event } from "./lib";

export type Message = { to: "coordinator" | "owner"; summary: string; body: string };

/** Deliver one message on a configured channel. Returns what happened, in a word or two; throws when it fails. */
export async function send(cfg: Config, message: Message, live: boolean): Promise<string> {
  const channel: Channel = cfg.notify[message.to];
  if (channel.channel === "none") return "no channel configured";
  const text = message.body ? `${message.summary}\n${message.body}` : message.summary;
  if (!live && !(message.to === "coordinator" && channel.channel === "file")) return "dry-run";
  if (channel.channel === "file") {
    // The coordinator chat runs wait.ts in the background; it returns whatever has not been handed over yet.
    const f = files(cfg);
    withLock(f.lock, () => {
      appendFileSync(f.wake, `--- ${new Date().toISOString()}\n${text}\n`, { mode: 0o600 });
      if (message.to === "coordinator") recordWake(f.events, message.summary);
    });
    return "written";
  }
  if (channel.channel === "command") {
    const run = Bun.spawnSync([...channel.command, message.summary, message.body], { stdout: "ignore", stderr: "ignore", timeout: 30000 });
    if (run.exitCode !== 0) throw Error(`the ${message.to} notification command exited ${run.exitCode}`);
    return "sent";
  }
  // Telegram Bot API. The token is read here, used once, and never logged or put in an error.
  const { botToken, chatId } = JSON.parse(readFileSync(channel.credentialsFile, "utf8"));
  const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }), signal: AbortSignal.timeout(15000) }).catch(() => null);
  if (!response?.ok) throw Error(`Telegram refused the message (${response?.status ?? "no answer"})`);
  return "sent";
}

export function recordWake(path: string, summary: string) {
  const at = Date.now();
  appendLine(path, { key: `wake:${at}`, at: new Date(at).toISOString(), type: "wake", text: summary, quiet: true } satisfies Event);
}

export function unansweredMinutes(cfg: Config, wakeAt: number, now: number): number | null {
  const minutes = (now - wakeAt) / 60000;
  return minutes >= cfg.notify.unansweredMinutes ? Math.round(minutes) : null;
}

function wakePosition(wake: string, size: number): number {
  let from = 0;
  try { from = Number(readFileSync(wake + ".delivered", "utf8")) || 0; } catch { /* nothing handed over yet */ }
  return from > size ? 0 : from; // the wake file was replaced
}

function pendingWakeAt(wake: string): number {
  try {
    const fd = openSync(wake, "r");
    try {
      const header = Buffer.alloc(29); // "--- " + ISO timestamp + newline
      readSync(fd, header, 0, header.length, wakePosition(wake, fstatSync(fd).size));
      return Date.parse(header.toString().match(/^--- ([^\n]+)\n/)?.[1] ?? "");
    } finally { closeSync(fd); }
  } catch { return NaN; }
}

export function newsHealth(cfg: Config, events: Event[], now: number) {
  const ack = events.findLast(e => e.type === "ack");
  const lastTaken = ack ? Date.parse(ack.at) : null;
  const minutes = cfg.notify.coordinator.channel === "file" ? unansweredMinutes(cfg, pendingWakeAt(files(cfg).wake), now) : null;
  return { lastTaken, wakeWarning: minutes === null ? null : `News has been waiting ${minutes} minutes; nobody is listening: start bun wait.ts` };
}

/** The only door to the owner. At most `ownerMaxPerDay` texts in any 24 hours; past that the text is held and shown on the page.
 *  The slot is reserved in the events file, under a lock, before anything is sent: two asks at once cannot both take the
 *  last slot, and a delivery that is interrupted has already used its slot. The outcome is recorded afterwards. */
export async function textOwner(cfg: Config, text: string, type: "owner-ask" | "unresponsive", live: boolean, now = Date.now()): Promise<Event & { outcome: string }> {
  const f = files(cfg), day = 24 * 3600000;
  let event: Event;
  try { event = withLock(f.lock, () => {
    const taken = readLines<Event>(f.events).filter(e => (e.type === "owner-ask" || e.type === "unresponsive") && !e.held && now - Date.parse(e.at) < day).length;
    const held = taken >= cfg.notify.ownerMaxPerDay;
    // A coordinator's own ask is quiet (it already knows); a held text or a watcher alarm is also told to the coordinator.
    const reserved: Event = { key: `${type}:${now}:${Math.random().toString(36).slice(2, 8)}`, at: new Date(now).toISOString(), type,
      text: held ? `Held, not sent to the owner (daily limit): ${text}` : text, quiet: type === "owner-ask" && !held, held };
    appendLine(f.events, reserved);
    return reserved;
  }); }
  // Fail closed: if the slot cannot be reserved, the text is held, never sent.
  catch (error) { return { key: `${type}:${now}:unreserved`, at: new Date(now).toISOString(), type, text, held: true, outcome: `held: ${error instanceof Error ? error.message : String(error)}` }; }
  if (event.held) return { ...event, outcome: `held: the limit of ${cfg.notify.ownerMaxPerDay} owner texts a day is reached` };
  const outcome = await send(cfg, { to: "owner", summary: text, body: "" }, live).catch(error => `failed: ${error instanceof Error ? error.message : String(error)}`);
  appendLine(f.events, { key: `owner-outcome:${event.key}`, at: new Date().toISOString(), type: "owner-outcome", text: `Text to the owner ${outcome}: ${text}`, quiet: !outcome.startsWith("failed") } satisfies Event);
  if (outcome.startsWith("failed")) throw Error(outcome);
  return { ...event, outcome };
}

/** The coordinator's side of the file channel: hand over everything written since the last hand-over.
 *  `deliver` runs first and only then is the position advanced and the hand-over acknowledged, so a crash in between
 *  cannot lose news. The price is at-least-once: after such a crash the same news is handed over again. */
export function takeNews(cfg: Config, deliver: (news: string) => void): boolean {
  const f = files(cfg), position = f.wake + ".delivered";
  return withLock(f.lock, () => {
    let size = 0;
    try { size = statSync(f.wake).size; } catch { return false; }
    const from = wakePosition(f.wake, size);
    if (size <= from) return false;
    const buffer = Buffer.alloc(size - from), fd = openSync(f.wake, "r");
    try { readSync(fd, buffer, 0, buffer.length, from); } finally { closeSync(fd); }
    deliver(buffer.toString("utf8"));
    writeFileSync(position + ".tmp", String(size)); renameSync(position + ".tmp", position);
    const takenAt = Date.now();
    appendLine(f.events, { key: `ack:${takenAt}`, at: new Date(takenAt).toISOString(), type: "ack", text: "the coordinator took its news", quiet: true } satisfies Event);
    return true;
  });
}
