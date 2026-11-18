#!/usr/bin/env bun
// One pass, run by launchd every 60 seconds. Plain code only: close jobs, read meters, notice what
// changed, send the coordinator at most one batched message per 5 minutes, write state.json for the page.
// Only the coordinator's ask command texts the owner.
// bun watch.ts [--dry-run]     Sends only when the config says notify.live and --dry-run is absent.
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { enabledProviders, loadConfig, type Config } from "./config";
import { EXIT_NOTE, KINDS, NO_RESULT, appendLine, clock, count, files, isOurLeader, jobs, percent, processStarted, readLines, slice, ticketAttempts, type Event, type Job, type Outcome, type Result, type Tokens } from "./lib";
import { meterLine, readMeters, type Meter } from "./meters";
import { legacyAsks, newsHealth, recordWake, reviewAsks, send, unansweredMinutes, type Message } from "./notify";
import { PROVIDERS } from "./providers";
import { STAGES, byStage, readTickets, showMinutes, ticketTimings, type Ticket } from "./ticket";

export const MAIL_GAP_MS = 5 * 60000, METER_GAP_MS = 15 * 60000, STUCK_MS = 30 * 60000, OVERHEAD_SHARE = 0.15, OVERHEAD_FLOOR = 500_000;
const minutesBetween = (from: number, to: number) => Math.round((to - from) / 6000) / 10;

export type Facts = { alive: boolean; pidInUse: boolean; finishedAt: number; lastGrowth: number; tokens: Tokens | null; exit?: number | "signal" };
/** Decide a running job's fate from observed facts. null means leave it running. */
export function judge(job: Job, f: Facts, now: number, silentMinutes: number): { result: Result; outcome: Outcome; reason: string } | null {
  const minutes = (now - Date.parse(job.started)) / 60000;
  if (!f.alive && typeof f.exit === "number" && f.exit !== 0)
    return { result: "failed", outcome: "failed", reason: `the job exited with status ${f.exit}; see its log` };
  if (!f.alive && f.exit === "signal") return { result: "stopped", outcome: "stopped", reason: "the job was killed" };
  if (!f.alive && f.finishedAt && (f.exit === 0 || job.outcome === undefined))
    return { result: "finished", outcome: "finished", reason: "result written" };
  // The recorded number now belongs to a process we cannot confirm as this job: signal nothing, say so.
  if (!f.alive && f.pidInUse && f.exit === undefined) return { result: "ended-unconfirmed", outcome: "stopped", reason: "its process could not be confirmed as this job, so nothing was signalled; check the run folder and any leftover processes by hand" };
  if (!f.alive) return { result: "stopped", outcome: "stopped", reason: NO_RESULT };
  if (f.finishedAt && now - f.finishedAt > 60000) return { result: "finished", outcome: "finished", reason: "result written; lingering process stopped" };
  if (minutes > job.capMinutes) return { result: "stopped-cap", outcome: "capped", reason: `ran past its ${job.capMinutes}-minute cap` };
  if (f.tokens?.fresh != null && f.tokens.fresh > job.capTokens) return { result: "stopped-cap", outcome: "capped", reason: `used ${count(f.tokens.fresh)} tokens, past its ${count(job.capTokens)} cap` };
  if (now - f.lastGrowth > silentMinutes * 60000) return { result: "stopped-silent", outcome: "stopped", reason: `wrote nothing for ${silentMinutes} minutes` };
  return null;
}
function harnessExit(dir: string) {
  try {
    const line = slice(join(dir, "log.txt"), 128, "end").trimEnd().split("\n").at(-1)!;
    if (!line.startsWith(EXIT_NOTE)) return;
    const status = line.slice(EXIT_NOTE.length);
    if (status === "signal") return status;
    if (/^\d+$/.test(status)) return Number(status);
  } catch { /* old or missing log */ }
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
  const askNews = pending.filter(e => e.askId), compact = askNews.map(e => e.text).join("\n").length > 500;
  const ordered = [...askNews, ...pending.filter(e => !e.askId)];
  for (const [i, e] of ordered.entries()) {
    const text = compact && e.askId ? `${e.type === "owner-default" ? "Default due" : e.type === "owner-recheck" ? "Recheck ask" : "Ask dropped"} · ${e.askId} (see events.jsonl)` : e.text;
    const line = `- ${text}${e.dir ? ` ${e.dir}` : ""}`, rest = `+${ordered.length - i} more in events.jsonl`;
    if ([...lines, line].join("\n").length > 790 - rest.length) { lines.push(rest); break; }
    lines.push(line);
  }
  const messages: Message[] = [{ to: "coordinator", summary, body: lines.join("\n") }];
  return { messages, cursor: { ...cursor, delivered: events.length, lastMailAt: now } };
}

/** Read "## Notes" and legacy "## Needs you", one item per line. */
export function stateOfPlay(path: string) {
  const out = { notes: [] as string[], needsYou: [] as string[], rewrittenAt: null as number | null };
  if (!existsSync(path)) return out;
  out.rewrittenAt = statSync(path).mtimeMs;
  let section = "";
  for (const raw of readFileSync(path, "utf8").replace(/<!--[\s\S]*?-->/g, "").split("\n")) {
    const heading = raw.match(/^##\s+(.*)/)?.[1]?.trim().toLowerCase();
    if (heading) { section = heading; continue; }
    const text = raw.replace(/^\s*(?:[-*]|\d+\.)\s+/, "").trim();
    if (text && section === "notes") out.notes.push(text);
    if (text && section === "needs you") out.needsYou.push(text);
  }
  return out;
}

export type Options = { cfg?: Config; now?: number; live?: boolean; meters?: (cfg: Config, previous: Meter[], now: number) => Promise<Meter[]> };
export async function pass(o: Options = {}) {
  const cfg = o.cfg ?? loadConfig(), f = files(cfg), now = o.now ?? Date.now(), live = o.live ?? false, time = clock(cfg.timezone);
  mkdirSync(cfg.privateDir, { recursive: true });
  let previous: any = {};
  try { previous = JSON.parse(readFileSync(f.state, "utf8")); } catch { /* first pass, or a torn file */ }
  const stored = readLines<Event>(f.events), seen = new Set(stored.map(e => e.key)), errors: string[] = [];
  const emit = (key: string, type: string, text: string, extra: Partial<Event> = {}) => {
    if (seen.has(key)) return;
    const event: Event = { key, at: new Date(now).toISOString(), type, text, ...extra };
    seen.add(key); appendLine(f.events, event);
  };

  // 1. Jobs: finished, silent or over cap.
  const running: (Job & { minutesSoFar: number })[] = [];
  for (const job of jobs(f.ledger).filter(j => j.event === "started")) {
    const provider = PROVIDERS[job.provider], started = Date.parse(job.started), facts = provider.facts(job.dir, started);
    const finishedAt = provider.finished(job.dir) ? statSync(join(job.dir, "result.txt")).mtimeMs : 0;
    const verdict = judge(job, { alive: alive(job), pidInUse: processStarted(job.pid) !== "", finishedAt, exit: harnessExit(job.dir), ...facts }, now, cfg.caps.silentMinutes);
    if (!verdict) { running.push({ ...job, tokens: facts.tokens, minutesSoFar: minutesBetween(started, now) }); continue; }
    stop(job);
    const tokens = provider.facts(job.dir, started).tokens, minutes = minutesBetween(started, now);
    appendLine(f.ledger, { ...job, event: "ended", ended: new Date(now).toISOString(), minutes, tokens, ...verdict } satisfies Job);
    const used = `${minutes} min, ${count(tokens?.fresh)} tokens`;
    const summary = verdict.outcome === "failed" ? "Failed" : "Stopped";
    emit(`job:${job.id}`, verdict.result, verdict.outcome === "finished" ? `Finished: ${job.name} (${used}).` : `${summary}: ${job.name}, ${verdict.reason} (${used}).`, { dir: job.dir });
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
    return { name: e.name, endsAt, renewedAt: endsAt === null ? null : made, paused };
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
  const timings = ticketTimings(tickets, all, readLines<Event>(f.events), now);
  const ready = byStage(tickets, "ready"), idleSince: number | null = !running.length && ready.length ? previous.idleSince ?? now : null;
  if (idleSince) emit(`idle:${idleSince}`, "idle", `Nothing is running and ${ready.length} ticket${ready.length > 1 ? "s are" : " is"} ready, first: ${ready[0]!.title}.`);
  const ticketRows = tickets.map(t => {
    const mine = ticketAttempts(t.id, all), job = running.find(j => j.ticket === t.id);
    const lastTouched = Math.max(Date.parse(t.updated), ...mine.map(j => Date.parse(j.ended ?? j.started)));
    if ((t.stage === "building" || t.stage === "in review") && !job && now - lastTouched >= STUCK_MS)
      emit(`stuck:${t.id}:${lastTouched}`, "stuck", `"${t.title}" is ${t.stage} but no job has run on it for ${Math.round((now - lastTouched) / 60000)} minutes.`);
    const timing = timings.get(t.id)!;
    if (t.stage !== "shipped" && t.stage !== "needs owner" && timing.state === "very over")
      emit(`ticket-pace:${t.id}`, "ticket-pace", `"${t.title}" is very over: ${showMinutes(timing.elapsed!)} min elapsed, ${showMinutes(timing.predicted!)} min predicted.`);
    return { ...t, timing, running: job?.name ?? null, jobs: mine.length, minutes: Math.round(mine.reduce((n, j) => n + (j.minutes ?? (job?.id === j.id ? job.minutesSoFar : 0)), 0)),
      tokens: mine.reduce((n, j) => n + ((job?.id === j.id ? job.tokens : j.tokens)?.fresh ?? 0), 0) };
  });

  // 4. Review open asks and notify the coordinator: one batched message per 5 minutes.
  const shipped = ended.filter(j => j.result === "finished"), play = stateOfPlay(f.stateOfPlay), ownerAsks = reviewAsks(cfg, now);
  // A lost state file must not replay old events: everything already stored counts as delivered.
  let cursor: Cursor = previous.notify ?? { delivered: stored.length, lastMailAt: 0 };
  const outbox: (Message & { at: string; outcome: string })[] = previous.outbox ?? [];
  const pending = readLines<Event>(f.events), next = batch(pending, cursor, now);
  try {
    for (const message of next.messages) {
      const outcome = await send(cfg, message, live);
      outbox.push({ ...message, at: new Date(now).toISOString(), outcome });
      if (outcome === "sent") recordWake(f.events, message.summary);
      if (outcome === "sent" || outcome === "written") for (const e of pending.slice(cursor.delivered, next.cursor.delivered)) {
        if (e.type === "owner-default") emit(`default-notified:${e.askId}`, "owner-default-notified",
          "The coordinator has been told the default is due.", { askId: e.askId, quiet: true });
      }
    }
    cursor = next.cursor;
  } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); } // nothing is marked delivered; the next pass tries again

  // Show unanswered coordinator wakes in Health.
  const activity = readLines<Event>(f.events);
  const health = newsHealth(cfg, activity, now);
  const ACTS = ["ticket", "ack", "owner-ask", "owner-resolved", "owner-reconfirmed", "owner-default-taken"];
  const lastSeen = Math.max(play.rewrittenAt ?? 0, ...activity.filter(e => ACTS.includes(e.type)).map(e => Date.parse(e.at)), ...all.map(j => Date.parse(j.started)));
  const since = activity.filter(e => Date.parse(e.at) > lastSeen);
  const minutes = unansweredMinutes(cfg, Date.parse(since.find(e => e.type === "wake")?.at ?? ""), now);
  const coordinatorUnresponsive = minutes !== null && tickets.some(t => ["ready", "building", "in review"].includes(t.stage));

  // 5. Everything the page needs.
  const row = (j: Job & { minutesSoFar?: number }) => ({ id: j.id, name: j.name, kind: j.kind, provider: j.provider, model: j.model, effort: j.effort, ticket: j.ticket, started: j.started, ended: j.ended,
    minutes: j.minutes ?? j.minutesSoFar ?? null, capMinutes: j.capMinutes, capTokens: j.capTokens, tokens: j.tokens, result: j.result, reason: j.reason, dir: j.dir });
  const defaults = new Map(activity.filter(e => e.type === "owner-default" || e.type === "owner-default-taken").map(e => [e.askId, e]));
  const notified = new Set(activity.filter(e => e.type === "owner-default-notified").map(e => e.askId));
  const defaultNotes = [...defaults.values()].map(e => `${time.at(Date.parse(e.at))} · ${e.text}`
    + (e.type === "owner-default" ? notified.has(e.askId) ? " · The coordinator has been told." : " · Coordinator notification pending." : ""));
  const state = {
    at: now, timezone: cfg.timezone, sending: live ? "live" : "dry-run", notes: [...play.notes, ...defaultNotes], stateOfPlayAt: play.rewrittenAt, needsYou: play.needsYou,
    running: running.map(row), tickets: ticketRows, stages: STAGES, shippedToday: shipped.map(row), stoppedToday: ended.filter(j => j.result !== "finished").map(row),
    split: { day: today, ...split, overhead, total }, meters, metersAt, expiries, idleSince, lastSeen, coordinatorUnresponsive,
    ownerAsks: [...ownerAsks, ...legacyAsks(activity).map(e => ({ id: e.key, at: e.at, text: e.text }))],
    ...health, fileWake: cfg.notify.coordinator.channel === "file",
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
