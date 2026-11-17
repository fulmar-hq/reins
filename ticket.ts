#!/usr/bin/env bun
// The tickets file and the coordinator's one-line commands for it. Only the coordinator writes it.
//   bun ticket.ts add --id 12 --title "Plain words" [--estimate minutes] [--due YYYY-MM-DD]
//   bun ticket.ts move 12 in review [--by name]      bun ticket.ts order 14 12 13      bun ticket.ts list
//   bun ticket.ts move 12 shipped --proof "What was checked and where"
//   bun ticket.ts ack     "I have seen the events so far" (any other command here also counts)
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, type Config } from "./config";
import { appendLine, files, withLock, type Event, type Job } from "./lib";

export const STAGES = ["ready", "building", "in review", "needs owner", "shipped"] as const;
export type Stage = (typeof STAGES)[number];
export type Ticket = {
  id: string; title: string; stage: Stage; order: number; link?: string; updated: string;
  estimate?: number; due?: string; shipment?: { proof: string };
  /** The four-part brief a builder is launched with. */
  brief: { job: string; doneMeans: string; whereToLook: string; check: string };
};
const path = (cfg: Config) => join(cfg.privateDir, "tickets.json");

export function readTickets(cfg: Config): Ticket[] {
  if (!existsSync(path(cfg))) return [];
  const tickets = JSON.parse(readFileSync(path(cfg), "utf8")).tickets;
  if (!Array.isArray(tickets)) throw Error("tickets.json must look like {\"tickets\": [...]}");
  return tickets;
}
function save(cfg: Config, tickets: Ticket[], note: string, by: string, now: number, stageEvent?: Pick<Event, "ticket" | "stage">) {
  mkdirSync(cfg.privateDir, { recursive: true });
  writeFileSync(path(cfg) + ".tmp", JSON.stringify({ tickets }, null, 2) + "\n", { mode: 0o600 });
  renameSync(path(cfg) + ".tmp", path(cfg));
  // The record of who moved what, when. Quiet: the coordinator is not woken about its own moves.
  appendLine(files(cfg).events, { key: `ticket:${now}:${note}`, at: new Date(now).toISOString(), type: "ticket", text: `${by} ${note}`, quiet: true, ...stageEvent } satisfies Event);
}
export function addTicket(cfg: Config, t: Partial<Ticket> & { id: string; title: string }, by = "coordinator", now = Date.now()) {
  const stage = t.stage ?? "ready";
  if (!STAGES.includes(stage)) throw Error(`A stage is one of: ${STAGES.join(", ")}.`);
  if (stage === "shipped") throw Error("Add the ticket first, then move it to shipped with --proof.");
  if (t.estimate !== undefined && (!Number.isFinite(t.estimate) || t.estimate <= 0))
    throw Error("An estimate needs a positive number of minutes.");
  if (t.due !== undefined && (!/^\d{4}-\d{2}-\d{2}$/.test(t.due) || !Number.isFinite(Date.parse(t.due)) || new Date(t.due).toISOString().slice(0, 10) !== t.due))
    throw Error("Give --due as a date in YYYY-MM-DD format.");
  withLock(files(cfg).lock, () => {
    const tickets = readTickets(cfg);
    if (tickets.some(x => x.id === t.id)) throw Error(`Ticket ${t.id} already exists.`);
    tickets.push({ id: t.id, title: t.title, stage, order: Math.max(0, ...tickets.map(x => x.order)) + 1, link: t.link, updated: new Date(now).toISOString(),
      estimate: t.estimate, due: t.due,
      brief: { job: "", doneMeans: "", whereToLook: "", check: "", ...t.brief } });
    save(cfg, tickets, `added "${t.title}" as ${stage}`, by, now, { ticket: t.id, stage });
  });
}
export function moveTicket(cfg: Config, id: string, stage: Stage, by = "coordinator", now = Date.now(), proof?: string) {
  withLock(files(cfg).lock, () => moveTicketLocked(cfg, id, stage, by, now, proof));
}

/** The caller holds the write lock. */
export function moveTicketLocked(cfg: Config, id: string, stage: Stage, by: string, now: number, proof?: string) {
  if (!STAGES.includes(stage)) throw Error(`A stage is one of: ${STAGES.join(", ")}.`);
  if (stage === "shipped" && !proof?.trim()) throw Error('Shipping needs --proof "What was checked and where".');
  const tickets = readTickets(cfg), ticket = tickets.find(t => t.id === id);
  if (!ticket) throw Error(`There is no ticket ${id}.`);
  const from = ticket.stage;
  if (from === stage) return;
  if (stage === "shipped") ticket.shipment = { proof: proof!.trim() };
  else delete ticket.shipment;
  Object.assign(ticket, { stage, updated: new Date(now).toISOString() });
  save(cfg, tickets, `moved "${ticket.title}" from ${from} to ${stage}`, by, now, { ticket: id, stage });
}
export function orderTickets(cfg: Config, ids: string[], by = "coordinator", now = Date.now()) {
  withLock(files(cfg).lock, () => {
    const tickets = readTickets(cfg), rest = tickets.filter(t => !ids.includes(t.id)).sort((a, b) => a.order - b.order);
    const named = ids.map(id => { const t = tickets.find(x => x.id === id); if (!t) throw Error(`There is no ticket ${id}.`); return t; });
    [...named, ...rest].forEach((t, i) => { t.order = i + 1; });
    save(cfg, tickets, `set the order to ${ids.join(", ")}`, by, now);
  });
}
export const byStage = (tickets: Ticket[], stage: Stage) => tickets.filter(t => t.stage === stage).sort((a, b) => stage === "ready" ? a.order - b.order : Date.parse(b.updated) - Date.parse(a.updated));

export const showMinutes = (minutes: number) => String(Number(minutes.toFixed(1)));

export function ticketTimings(tickets: Ticket[], all: Job[], events: Event[], now: number) {
  const history = events.filter(e => e.type === "ticket").map(e => ({ ...e, time: Date.parse(e.at) }));
  // Only tickets added before IDs were recorded can own a title-only event.
  const added = new Set(history.filter(e => e.key.startsWith(`ticket:${e.time}:added "`)).map(e => e.ticket));
  const legacy = tickets.filter(t => !added.has(t.id));
  const times = tickets.map(t => {
    const end = t.stage === "shipped" ? Math.min(now, Date.parse(t.updated)) : now;
    const start = Math.min(Infinity, ...all.filter(j => j.ticket === t.id).map(j => Date.parse(j.started)).filter(at => at <= end));
    if (start > end) return { t, ms: null };
    const ownsTitle = !added.has(t.id) && legacy.filter(x => x.title === t.title).length === 1;
    const stages = history.flatMap(e => {
      if (e.time > end) return [];
      if (e.ticket !== undefined) return e.ticket === t.id && e.stage ? [{ stage: e.stage, time: e.time }] : [];
      if (!ownsTitle) return [];
      const old = e.text.match(/ (?:added "(.*)" as|moved "(.*)" from (?:ready|building|in review|needs owner|shipped) to) (ready|building|in review|needs owner|shipped)$/);
      return old && (old[1] ?? old[2]) === t.title ? [{ stage: old[3]!, time: e.time }] : [];
    }).sort((a, b) => a.time - b.time);
    const updated = Date.parse(t.updated);
    if (updated <= end && stages.at(-1)?.stage !== t.stage && updated >= (stages.at(-1)?.time ?? -Infinity))
      stages.push({ stage: t.stage, time: updated });
    const paused = stages.reduce((ms, { stage, time }, i) => stage !== "needs owner" ? ms
      : ms + Math.max(0, (stages[i + 1]?.time ?? end) - Math.max(start, time)), 0);
    return { t, ms: end - start - paused };
  });
  const past = times.flatMap(({ t, ms }) => t.stage === "shipped" && Date.parse(t.updated) <= now && ms !== null ? [ms] : []).sort((a, b) => a - b);
  const median = past.length < 3 ? null : (past[Math.floor((past.length - 1) / 2)]! + past[Math.floor(past.length / 2)]!) / 120000;
  return new Map(times.map(({ t, ms }) => {
    const predicted = t.estimate ?? median, elapsed = ms === null ? null : ms / 60000;
    // Divide elapsed milliseconds by 1.5 minutes before comparing to the estimate.
    const state = ms === null || predicted === null ? null
      : ms / 60000 <= predicted ? "on track" : ms / 90000 <= predicted ? "a little over" : "very over";
    return [t.id, { elapsed, predicted, state }] as const;
  }));
}

if (import.meta.main) {
  const [verb, ...rest] = process.argv.slice(2), cfg = loadConfig();
  const flag = (name: string) => {
    const i = rest.indexOf(name);
    if (i < 0) return;
    const value = rest[i + 1];
    if (value === undefined || (["--estimate", "--due", "--proof"].includes(name) && value.startsWith("--")))
      throw Error(`Give a value after ${name}.`);
    rest.splice(i, 2);
    return value;
  };
  try {
    const by = flag("--by");
    if (verb === "add") {
      const id = flag("--id"), title = flag("--title"), estimate = flag("--estimate"), due = flag("--due");
      if (!id || !title) throw Error("add needs --id and --title");
      addTicket(cfg, { id, title, stage: flag("--stage") as Stage | undefined, link: flag("--link"),
        estimate: estimate === undefined ? undefined : Number(estimate), due,
        brief: { job: flag("--job") ?? "", doneMeans: flag("--done") ?? "", whereToLook: flag("--where") ?? "", check: flag("--check") ?? "" } }, by);
    } else if (verb === "move") {
      const proof = flag("--proof");
      moveTicket(cfg, rest[0] ?? "", rest.slice(1).join(" ") as Stage, by, Date.now(), proof);
    } else if (verb === "order") orderTickets(cfg, rest, by);
    else if (verb === "ack") appendLine(files(cfg).events, { key: `ack:${Date.now()}`, at: new Date().toISOString(), type: "ack", text: `${by ?? "coordinator"} acknowledged the events so far`, quiet: true } satisfies Event);
    else if (verb !== "list") throw Error("usage: ticket.ts add|move|order|ack|list (see the top of ticket.ts)");
    for (const stage of STAGES) for (const t of byStage(readTickets(cfg), stage)) console.log(`${stage.padEnd(12)} ${t.id.padEnd(8)} ${t.title}`);
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); }
}
