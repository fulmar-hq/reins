#!/usr/bin/env bun
// One pass, run by launchd every 60 seconds. Plain code only: close jobs, read meters, notice what
// changed, send the coordinator at most one batched message per 5 minutes, write state.json for the page.
// The owner is never texted about progress: see textOwner in notify.ts for the only two cases.
// bun watch.ts [--dry-run]     Sends only when the config says notify.live and --dry-run is absent.
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { enabledProviders, loadConfig, type Config } from "./config";
import { KINDS, appendLine, clock, count, files, isOurLeader, jobs, percent, processStarted, readLines, type Event, type Job, type Result, type Tokens } from "./lib";
import { meterLine, readMeters, type Meter } from "./meters";
import { send, textOwner, type Message } from "./notify";
import { PROVIDERS } from "./providers";
import { STAGES, byStage, readTickets, type Ticket } from "./ticket";

export const MAIL_GAP_MS = 5 * 60000, METER_GAP_MS = 15 * 60000, STUCK_MS = 30 * 60000, OVERHEAD_SHARE = 0.15, OVERHEAD_FLOOR = 500_000;
const minutesBetween = (from: number, to: number) => Math.round((to - from) / 6000) / 10;

export type Facts = { alive: boolean; pidInUse: boolean; finishedAt: number; lastGrowth: number; tokens: Tokens | null };
/** Decide a running job's fate from observed facts. null means leave it running. */
export function judge(job: Job, f: Facts, now: number, silentMinutes: number): { result: Result; reason: string } | null {
  const minutes = (now - Date.parse(job.started)) / 60000;
  if (!f.alive && f.finishedAt) return { result: "finished", reason: "result written" };
  // The recorded number now belongs to a process we cannot confirm as this job: signal nothing, say so.
  if (!f.alive && f.pidInUse) return { result: "ended-unconfirmed", reason: "its process could not be confirmed as this job, so nothing was signalled; check the run folder and any leftover processes by hand" };
  if (!f.alive) return { result: "failed", reason: "the job ended without a result" };
  if (f.finishedAt && now - f.finishedAt > 60000) return { result: "finished", reason: "result written; lingering process stopped" };
  if (minutes > job.capMinutes) return { result: "stopped-cap", reason: `ran past its ${job.capMinutes}-minute cap` };
  if (f.tokens?.fresh != null && f.tokens.fresh > job.capTokens) return { result: "stopped-cap", reason: `used ${count(f.tokens.fresh)} tokens, past its ${count(job.capTokens)} cap` };
  if (now - f.lastGrowth > silentMinutes * 60000) return { result: "stopped-silent", reason: `wrote nothing for ${silentMinutes} minutes` };
  return null;
}
/** True only while the recorded process is still this job: same pid, same start time, leading its own group. */
const alive = (job: Job) => isOurLeader(job.pid, job.pidStarted);
/** Signal the job's process group only after confirming, right now, that its recorded leader is alive and is ours. */
function signal(job: Job, name: "SIGTERM" | "SIGKILL"): boolean {
  if (!alive(job)) return false;
  try { process.kill(-job.pid, name); return true; } catch { return false; }
}
/** Stop a job. Once its leader is gone nothing more is signalled: any children it left are left alone. */
export function stop(job: Job) {
  if (!signal(job, "SIGTERM")) return;
  for (let i = 0; i < 30 && alive(job); i++) Bun.sleepSync(100);
  signal(job, "SIGKILL");
}

export type Cursor = { delivered: number; lastMailAt: number };
/** Everything undelivered becomes one coordinator message, at most once per 5 minutes. */
export function batch(events: Event[], cursor: Cursor, now: number): { messages: Message[]; cursor: Cursor } {
  const pending = events.slice(cursor.delivered).filter(e => !e.quiet);
  if (!pending.length) return { messages: [], cursor: { ...cursor, delivered: events.length } };
  if (now - cursor.lastMailAt < MAIL_GAP_MS) return { messages: [], cursor };
  const lines: string[] = [], summary = (pending.length === 1 ? pending[0]!.text : `${pending.length} changes. ${pending[0]!.text}`).slice(0, 120);
  for (const [i, e] of pending.entries()) {
    const line = `- ${e.text}${e.dir ? ` ${e.dir}` : ""}`, rest = `+${pending.length - i} more in events.jsonl`;
    if ([...lines, line].join("\n").length > 790 - rest.length) { lines.push(rest); break; }
    lines.push(line);
  }
  const messages: Message[] = [{ to: "coordinator", summary, body: lines.join("\n") }];
  return { messages, cursor: { ...cursor, delivered: events.length, lastMailAt: now } };
}

/** state-of-play.md: "## Needs you" and "## Notes", one item per line; HTML comments are ignored. */
export function stateOfPlay(path: string) {
  const out = { needsYou: [] as string[], notes: [] as string[], rewrittenAt: null as number | null };
  if (!existsSync(path)) return out;
  out.rewrittenAt = statSync(path).mtimeMs;
  let section = "";
  for (const raw of readFileSync(path, "utf8").replace(/<!--[\s\S]*?-->/g, "").split("\n")) {
    const heading = raw.match(/^##\s+(.*)/)?.[1]?.trim().toLowerCase();
    if (heading) { section = heading; continue; }
    const text = raw.replace(/^\s*(?:[-*]|\d+\.)\s+/, "").trim();
    if (text && section.startsWith("needs")) out.needsYou.push(text);
    else if (text && section === "notes") out.notes.push(text);
  }
  return out;
}

export type Options = { cfg?: Config; now?: number; live?: boolean; meters?: (cfg: Config, previous: Meter[], now: number) => Promise<Meter[]> };
export async function pass(o: Options = {}) {
  const cfg = o.cfg ?? loadConfig(), f = files(cfg), now = o.now ?? Date.now(), live = o.live ?? false, time = clock(cfg.timezone);
  mkdirSync(cfg.privateDir, { recursive: true });
  let previous: any = {};
  try { previous = JSON.parse(readFileSync(f.state, "utf8")); } catch { /* first pass, or a torn file */ }
  const stored = readLines<Event>(f.events), seen = new Set(stored.map(e => e.key)), errors: string[] = [], alreadyStored = stored.length;
  const emit = (key: string, type: string, text: string, extra: Partial<Event> = {}) => {
    if (seen.has(key)) return;
    const event: Event = { key, at: new Date(now).toISOString(), type, text, ...extra };
    seen.add(key); stored.push(event); appendLine(f.events, event);
  };

  // 1. Jobs: finished, silent or over cap.
  const running: (Job & { minutesSoFar: number })[] = [];
  for (const job of jobs(f.ledger).filter(j => j.event === "started")) {
    const provider = PROVIDERS[job.provider], started = Date.parse(job.started), facts = provider.facts(job.dir, started);
    const finishedAt = provider.finished(job.dir) ? statSync(join(job.dir, "result.txt")).mtimeMs : 0;
    const verdict = judge(job, { alive: alive(job), pidInUse: processStarted(job.pid) !== "", finishedAt, ...facts }, now, cfg.caps.silentMinutes);
    if (!verdict) { running.push({ ...job, tokens: facts.tokens, minutesSoFar: minutesBetween(started, now) }); continue; }
    stop(job);
    const tokens = provider.facts(job.dir, started).tokens, minutes = minutesBetween(started, now);
    appendLine(f.ledger, { ...job, event: "ended", ended: new Date(now).toISOString(), minutes, tokens, ...verdict } satisfies Job);
    const used = `${minutes} min, ${count(tokens?.fresh)} tokens`;
    emit(`job:${job.id}`, verdict.result, verdict.result === "finished" ? `Finished: ${job.name} (${used}).` : `Stopped: ${job.name}, ${verdict.reason} (${used}).`, { dir: job.dir });
  }

  // 2. Meters, refreshed every 15 minutes; between refreshes the last reading stands.
  let meters: Meter[] = previous.meters ?? [], metersAt: number = previous.metersAt ?? 0;
  const refresh = now - metersAt >= METER_GAP_MS;
  if (refresh) try { meters = await (o.meters ?? readMeters)(cfg, meters, now); metersAt = now; } catch (error) { errors.push(`meters: ${String(error)}`); }
  for (const m of meters) {
    if (m.used === null || m.reason) continue; // only a fresh real reading can raise an event
    const crossed = [1, 0.8, 0.5].find(t => m.used! >= t);
    if (crossed) emit(`meter:${m.id}:${m.resetsAt}:${crossed}`, "meter", `${m.label} passed ${percent(crossed)}. ${meterLine(m, time.at)}.`);
    if (m.verdict === "too fast") emit(`pace:${m.id}:${m.resetsAt}`, "too-fast", `${meterLine(m, time.at)}, before it resets ${time.at(m.resetsAt!)}.`);
  }
  const expiries = cfg.expiries.map(e => {
    let made = NaN;
    try { made = Date.parse(readFileSync(e.recordFile, "utf8").trim()); } catch { /* no record */ }
    const endsAt = Number.isFinite(made) ? made + e.hours * 3600000 : null, paused = Boolean(e.pausedFile && existsSync(e.pausedFile));
    if (endsAt && !paused && endsAt > now && endsAt - now <= 3 * 3600000)
      emit(`expiry:${e.name}:${endsAt}`, "expiry", `${e.name} ends ${time.at(endsAt)}; only the owner can renew it.`);
    return { name: e.name, endsAt, paused };
  });

  // 3. Today in the configured timezone: finished work, the usage split, tickets, idleness.
  const today = time.day(now), all = jobs(f.ledger), ended = all.filter(j => j.event === "ended" && time.day(Date.parse(j.ended!)) === today);
  const split: Record<string, number> = Object.fromEntries(KINDS.map(k => [k, 0]));
  for (const j of [...ended, ...running]) split[j.kind]! += j.tokens?.fresh ?? 0;
  let overhead: number = previous.split?.day === today ? previous.split.overhead : 0;
  if (refresh || previous.split?.day !== today) {
    const dirs = [...ended, ...running].map(j => j.dir);
    overhead = enabledProviders(cfg).reduce((sum, name) => sum + (PROVIDERS[name].otherTokensToday?.(time.dayStart(now), dirs) ?? 0), 0);
  }
  const total = Object.values(split).reduce((a, b) => a + b, 0) + overhead;
  if (total >= OVERHEAD_FLOOR && overhead / total > OVERHEAD_SHARE)
    emit(`overhead:${today}`, "overhead", `Overhead is ${percent(overhead / total)} of today's usage: ${count(overhead)} of ${count(total)} tokens went to sessions that are not launched jobs.`);
  let tickets: Ticket[] = [];
  try { tickets = readTickets(cfg); } catch (error) { errors.push(`tickets.json: ${error instanceof Error ? error.message : String(error)}`); }
  const ready = byStage(tickets, "ready"), idleSince: number | null = !running.length && ready.length ? previous.idleSince ?? now : null;
  if (idleSince) emit(`idle:${idleSince}`, "idle", `Nothing is running and ${ready.length} ticket${ready.length > 1 ? "s are" : " is"} ready, first: ${ready[0]!.title}.`);
  const ticketRows = tickets.map(t => {
    const mine = all.filter(j => j.ticket === t.id), job = running.find(j => j.ticket === t.id);
    const lastTouched = Math.max(Date.parse(t.updated), ...mine.map(j => Date.parse(j.ended ?? j.started)));
    if ((t.stage === "building" || t.stage === "in review") && !job && now - lastTouched >= STUCK_MS)
      emit(`stuck:${t.id}:${lastTouched}`, "stuck", `"${t.title}" is ${t.stage} but no job has run on it for ${Math.round((now - lastTouched) / 60000)} minutes.`);
    return { ...t, running: job?.name ?? null, jobs: mine.length, minutes: Math.round(mine.reduce((n, j) => n + (j.minutes ?? (job?.id === j.id ? job.minutesSoFar : 0)), 0)),
      tokens: mine.reduce((n, j) => n + ((job?.id === j.id ? job.tokens : j.tokens)?.fresh ?? 0), 0) };
  });

  // 4. Notify the coordinator: one batched message per 5 minutes.
  const shipped = ended.filter(j => j.result === "finished"), play = stateOfPlay(f.stateOfPlay);
  // A lost state file must not replay old events: everything already stored counts as delivered.
  let cursor: Cursor = previous.notify ?? { delivered: alreadyStored, lastMailAt: 0 };
  const outbox: (Message & { at: string; outcome: string })[] = previous.outbox ?? [];
  const next = batch(stored, cursor, now);
  try {
    for (const message of next.messages) {
      outbox.push({ ...message, at: new Date(now).toISOString(), outcome: await send(cfg, message, live) });
      // Recorded after the hand-off, so "the coordinator was woken at this time" is never earlier than the truth.
      const woke: Event = { key: `wake:${Date.now()}`, at: new Date().toISOString(), type: "wake", text: message.summary, quiet: true };
      stored.push(woke); appendLine(f.events, woke);
    }
    cursor = next.messages.length ? { ...next.cursor, delivered: stored.length } : next.cursor;
  } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); } // nothing is marked delivered; the next pass tries again

  // The one automatic owner text: the coordinator was woken, has not acted since, and work is waiting.
  // It "acts" by running a ticket command, launching a job, taking its news (wait.ts), asking the owner, or rewriting its notes.
  // Everything here is derived from the append-only events file, so a lost state.json cannot cause a second text.
  const ACTS = ["ticket", "ack", "owner-ask", "owner-resolved"];
  const lastSeen = Math.max(play.rewrittenAt ?? 0, ...stored.filter(e => ACTS.includes(e.type)).map(e => Date.parse(e.at)), ...all.map(j => Date.parse(j.started)));
  const since = stored.filter(e => Date.parse(e.at) > lastSeen), unanswered = since.find(e => e.type === "wake");
  const unresponsiveAlerted = since.some(e => e.type === "unresponsive"), workWaiting = tickets.some(t => ["ready", "building", "in review"].includes(t.stage));
  const coordinatorUnresponsive = unanswered !== undefined && workWaiting && now - Date.parse(unanswered.at) >= cfg.notify.unansweredMinutes * 60000;
  if (coordinatorUnresponsive && !unresponsiveAlerted) try {
    const minutes = Math.round((now - Date.parse(unanswered.at)) / 60000);
    const sent = await textOwner(cfg, `The coordinator chat has not responded for ${minutes} minutes and work is waiting. Please open it.`, "unresponsive", live, now);
    stored.push(sent); outbox.push({ to: "owner", summary: sent.text, body: "", at: sent.at, outcome: sent.outcome });
  } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
  const resolvedAt = Math.max(0, ...stored.filter(e => e.type === "owner-resolved").map(e => Date.parse(e.at)));
  const ownerAsks = stored.filter(e => (e.type === "owner-ask" || e.type === "unresponsive") && Date.parse(e.at) > resolvedAt).map(e => ({ at: e.at, text: e.text, held: Boolean(e.held) }));

  // 5. Everything the page needs.
  const row = (j: Job & { minutesSoFar?: number }) => ({ id: j.id, name: j.name, kind: j.kind, provider: j.provider, ticket: j.ticket, started: j.started, ended: j.ended,
    minutes: j.minutes ?? j.minutesSoFar ?? null, capMinutes: j.capMinutes, capTokens: j.capTokens, tokens: j.tokens, result: j.result, reason: j.reason, dir: j.dir });
  const state = {
    at: now, timezone: cfg.timezone, sending: live ? "live" : "dry-run", needsYou: play.needsYou, notes: play.notes, stateOfPlayAt: play.rewrittenAt,
    running: running.map(row), tickets: ticketRows, stages: STAGES, shippedToday: shipped.map(row), stoppedToday: ended.filter(j => j.result !== "finished").map(row),
    split: { day: today, ...split, overhead, total }, meters, metersAt, expiries, idleSince, ownerAsks, lastSeen, coordinatorUnresponsive,
    notify: cursor, outbox: outbox.slice(-10), errors,
  };
  writeFileSync(f.state + ".tmp", JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  renameSync(f.state + ".tmp", f.state);
  return state;
}
export type State = Awaited<ReturnType<typeof pass>>;

if (import.meta.main) {
  const cfg = loadConfig(), live = cfg.notify.live && !process.argv.includes("--dry-run");
  const state = await pass({ cfg, live });
  console.log(`${new Date(state.at).toISOString()} ${state.sending}: ${state.running.length} running, ${state.shippedToday.length} shipped today, ${state.errors.length} errors`);
  process.exit(0);
}
