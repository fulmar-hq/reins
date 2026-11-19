// Notifications behind one small function. Dry-run sends nothing outside this machine: the coordinator's own
// wake file is still written, because a job that finishes unnoticed is the failure this project exists to prevent.
import { appendFileSync, closeSync, fstatSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from "node:fs";
import type { Channel, Config } from "./config";
import { appendLine, files, readLines, withLock, type Ask, type Event } from "./lib";

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

const reasons = ["sign-in or credential", "spending past a limit", "message to a real person", "change to a live system for a real customer", "product taste"];
const day = 86400000;
const oneLine = (text: string | undefined): text is string => Boolean(text?.trim()) && !/[\r\n\u2028\u2029]/.test(text!);

function readAsk(args: string[], now: number): Ask {
  const [question, recommendation, reason, deadline, action, ...extra] = args.map(s => s.trim());
  const sentence = question?.replace(/\b([ap])\.m\./gi, "$1m") ?? "";
  if (!oneLine(question) || !/^[^?]+\?$/.test(question) || !/[\p{L}\p{N}]/u.test(question) || /[.!]["'”’)]*\s+\p{Ll}/u.test(sentence)
    || [...new Intl.Segmenter("en", { granularity: "sentence" }).segment(sentence)].length !== 1)
    throw Error("Give one question in a single sentence ending in a question mark.");
  if (!oneLine(recommendation) || recommendation.startsWith("--")) throw Error("Give the coordinator's recommendation on one line.");
  if (!reason || !reasons.includes(reason)) throw Error(`Choose one reason: ${reasons.join(", ")}.`);
  if (deadline === "--no-safe-default") {
    if (action !== undefined) throw Error("Use --no-safe-default on its own, or give a deadline and a default action.");
    if (!reasons.slice(0, 2).includes(reason)) throw Error("Only sign-in or credential and spending past a limit can have no safe default.");
    return { question, recommendation, reason, fallback: null };
  }
  if (!deadline || !oneLine(action) || action.startsWith("--") || extra.length) throw Error("Give a deadline and one default action, or use --no-safe-default on its own.");
  const at = Date.parse(deadline);
  if (!Number.isFinite(at) || new Date(at).toISOString().replace(".000Z", "Z") !== deadline || at <= now)
    throw Error("Give a future UTC deadline in YYYY-MM-DDTHH:mm:ssZ format.");
  return { question, recommendation, reason, fallback: { at, action } };
}

export type OpenAsk = Ask & { id: string; at: string; confirmedAt: number; reviewBy: number | null; held?: boolean };
export function openAsks(events: Event[]): OpenAsk[] {
  const open = new Map<string, OpenAsk>();
  for (const e of events) {
    if (e.type === "owner-ask" && e.ask)
      open.set(e.key, { ...e.ask, id: e.key, at: e.at, confirmedAt: Date.parse(e.at), reviewBy: null, held: e.held });
    const ask = e.askId && open.get(e.askId);
    if (!ask) continue;
    if (e.type === "owner-recheck") ask.reviewBy = Date.parse(e.at) + day;
    if (e.type === "owner-reconfirmed") { ask.confirmedAt = Date.parse(e.at); ask.reviewBy = null; }
    if (["owner-resolved", "owner-default", "owner-dropped"].includes(e.type)) open.delete(ask.id);
  }
  return [...open.values()];
}

export function legacyAsks(events: Event[]) {
  const cleared = events.findLastIndex(e => e.type === "owner-resolved" && !e.askId);
  const answered = new Set(events.filter(e => e.type === "owner-resolved").map(e => e.askId));
  return events.slice(cleared + 1).filter(e => e.type === "owner-ask" && !e.ask && !answered.has(e.key));
}

export function askEnded(ask: OpenAsk, now: number) {
  if (ask.reviewBy !== null && ask.reviewBy <= now && ask.reviewBy < (ask.fallback?.at ?? Infinity)) return "owner-dropped";
  if (ask.fallback && ask.fallback.at <= now) return "owner-default";
}

function askEvent(id: string, type: string, text: string, now: number, quiet = false): Event {
  return { key: `${type}:${id}:${now}`, askId: id, at: new Date(now).toISOString(), type, text, quiet };
}

export function updateAsk(cfg: Config, action: "resolved" | "reconfirm", id: string | undefined, answer?: string, now = Date.now()) {
  if (!id) throw Error("Give the ask ID.");
  if (action === "resolved" && !oneLine(answer)) throw Error("Give the answer or the action taken on one line.");
  const f = files(cfg);
  withLock(f.lock, () => {
    const events = readLines<Event>(f.events), ask = openAsks(events).find(a => a.id === id);
    const latestDefault = events.findLast(e => e.askId === id && (e.type === "owner-default" || e.type === "owner-default-taken"));
    if (action === "resolved" && latestDefault?.type === "owner-default") {
      appendLine(f.events, askEvent(id, "owner-default-taken", `default taken — ${id}: ${answer!.trim()}`, now, true));
      return;
    }
    const question = ask && !askEnded(ask, now) ? ask.question : action === "resolved" ? legacyAsks(events).find(e => e.key === id)?.text : undefined;
    if (!question) throw Error("There is no open ask or pending default with that ID.");
    appendLine(f.events, action === "resolved"
      ? askEvent(id, "owner-resolved", `${question} Owner's answer: ${answer!.trim()}`, now, true)
      : askEvent(id, "owner-reconfirmed", `Reconfirmed: ${question}`, now, true));
  });
}

/** The caller holds the write lock. */
export function reviewAsksLocked(cfg: Config, now: number): OpenAsk[] {
  const f = files(cfg);
  return openAsks(readLines<Event>(f.events)).filter(ask => {
    const ended = askEnded(ask, now);
    const label = `${ask.id} · ${ask.question}`;
    if (ended === "owner-default")
      appendLine(f.events, askEvent(ask.id, ended, `default due — ${label} take the default now: ${ask.fallback!.action}`, now));
    else if (ended === "owner-dropped")
      appendLine(f.events, askEvent(ask.id, ended, `dropped: not reconfirmed — ${label}`, now));
    else if (ask.reviewBy === null && now - ask.confirmedAt >= 2 * day) {
      appendLine(f.events, askEvent(ask.id, "owner-recheck", `Check this ask against the facts and reconfirm within one day: ${label}`, now));
      ask.reviewBy = now + day;
    }
    return !ended;
  });
}

/** Accept the ask and reserve its text slot together under the existing lock.
 *  Failed or interrupted deliveries still use the slot. Legacy alerts count until their 24 hours are up. */
export async function textOwner(cfg: Config, args: string[], live: boolean, now = Date.now()): Promise<Event & { outcome: string }> {
  const ask = readAsk(args, now), f = files(cfg), type = "owner-ask";
  const text = `${ask.question}\nI recommend: ${ask.recommendation}\nReason: ${ask.reason}\n`
    + (ask.fallback ? `If no answer by ${new Date(ask.fallback.at).toISOString()}, I will ${ask.fallback.action}` : "No safe default exists.");
  const event = withLock(f.lock, () => {
    const activity = readLines<Event>(f.events);
    if (openAsks(activity).filter(a => !askEnded(a, now)).length >= 3) throw Error("Three asks are already open. Close one before adding another.");
    const taken = activity.filter(e => (e.type === "owner-ask" || e.type === "unresponsive") && !e.held && now - Date.parse(e.at) < day).length;
    const held = taken >= cfg.notify.ownerMaxPerDay;
    const reserved: Event = { key: crypto.randomUUID(), at: new Date(now).toISOString(), type, ask,
      text: held ? `Held, not sent to the owner (daily limit): ${ask.question}` : text, quiet: !held, held };
    appendLine(f.events, reserved);
    return reserved;
  });
  if (event.held) return { ...event, outcome: `held: the limit of ${cfg.notify.ownerMaxPerDay} owner texts a day is reached` };
  const outcome = await send(cfg, { to: "owner", summary: text, body: "" }, live).catch(error => `failed: ${error instanceof Error ? error.message : String(error)}`);
  appendLine(f.events, { key: `owner-outcome:${event.key}`, at: new Date().toISOString(), type: "owner-outcome", text: `Text to the owner ${outcome}: ${text}`, quiet: !outcome.startsWith("failed") } satisfies Event);
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
