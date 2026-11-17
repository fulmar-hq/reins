// Notifications behind one small function. Dry-run sends nothing at all.
import { appendFileSync, closeSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from "node:fs";
import type { Channel, Config } from "./config";
import { appendLine, files, readLines, withLock, type Event } from "./lib";

export type Message = { to: "coordinator" | "owner"; summary: string; body: string };

/** Deliver one message on a configured channel. Returns what happened, in a word or two; throws when it fails. */
export async function send(cfg: Config, message: Message, live: boolean): Promise<string> {
  const channel: Channel = cfg.notify[message.to];
  if (channel.channel === "none") return "no channel configured";
  if (!live) return "dry-run";
  const text = message.body ? `${message.summary}\n${message.body}` : message.summary;
  if (channel.channel === "file") {
    // The coordinator chat runs wait.ts in the background; it returns whatever has not been handed over yet.
    appendFileSync(files(cfg).wake, `--- ${new Date().toISOString()}\n${text}\n`, { mode: 0o600 });
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
    const takenAt = Date.now(); // before reading: a wake recorded after this moment is not covered by this acknowledgement
    let size = 0, from = 0;
    try { size = statSync(f.wake).size; } catch { return false; }
    try { from = Number(readFileSync(position, "utf8")) || 0; } catch { /* nothing handed over yet */ }
    if (from > size) from = 0; // the wake file was replaced
    if (size <= from) return false;
    const buffer = Buffer.alloc(size - from), fd = openSync(f.wake, "r");
    try { readSync(fd, buffer, 0, buffer.length, from); } finally { closeSync(fd); }
    deliver(buffer.toString("utf8"));
    writeFileSync(position + ".tmp", String(size)); renameSync(position + ".tmp", position);
    appendLine(f.events, { key: `ack:${takenAt}`, at: new Date(takenAt).toISOString(), type: "ack", text: "the coordinator took its news", quiet: true } satisfies Event);
    return true;
  });
}
