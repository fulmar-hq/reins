#!/usr/bin/env bun
// The tickets file and the coordinator's one-line commands for it. Only the coordinator writes it.
//   bun ticket.ts add --id 12 --title "Plain words" [--link URL] [--job ..] [--done ..] [--where ..] [--check ..] [--stage ready]
//   bun ticket.ts move 12 in review [--by name]      bun ticket.ts order 14 12 13      bun ticket.ts list
//   bun ticket.ts ack     "I have seen the events so far" (any other command here also counts)
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, type Config } from "./config";
import { appendLine, files, type Event } from "./lib";

export const STAGES = ["ready", "building", "in review", "needs owner", "shipped"] as const;
export type Stage = (typeof STAGES)[number];
export type Ticket = {
  id: string; title: string; stage: Stage; order: number; link?: string; updated: string;
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
function save(cfg: Config, tickets: Ticket[], note: string, by: string, now: number) {
  mkdirSync(cfg.privateDir, { recursive: true });
  writeFileSync(path(cfg) + ".tmp", JSON.stringify({ tickets }, null, 2) + "\n", { mode: 0o600 });
  renameSync(path(cfg) + ".tmp", path(cfg));
  // The record of who moved what, when. Quiet: the coordinator is not woken about its own moves.
  appendLine(files(cfg).events, { key: `ticket:${now}:${note}`, at: new Date(now).toISOString(), type: "ticket", text: `${by} ${note}`, quiet: true } satisfies Event);
}
export function addTicket(cfg: Config, t: Partial<Ticket> & { id: string; title: string }, by = "coordinator", now = Date.now()) {
  const tickets = readTickets(cfg), stage = t.stage ?? "ready";
  if (tickets.some(x => x.id === t.id)) throw Error(`Ticket ${t.id} already exists.`);
  if (!STAGES.includes(stage)) throw Error(`A stage is one of: ${STAGES.join(", ")}.`);
  tickets.push({ id: t.id, title: t.title, stage, order: Math.max(0, ...tickets.map(x => x.order)) + 1, link: t.link, updated: new Date(now).toISOString(),
    brief: { job: "", doneMeans: "", whereToLook: "", check: "", ...t.brief } });
  save(cfg, tickets, `added "${t.title}" as ${stage}`, by, now);
}
export function moveTicket(cfg: Config, id: string, stage: Stage, by = "coordinator", now = Date.now()) {
  const tickets = readTickets(cfg), ticket = tickets.find(t => t.id === id);
  if (!ticket) throw Error(`There is no ticket ${id}.`);
  if (!STAGES.includes(stage)) throw Error(`A stage is one of: ${STAGES.join(", ")}.`);
  if (ticket.stage === stage) return;
  const from = ticket.stage;
  Object.assign(ticket, { stage, updated: new Date(now).toISOString() });
  save(cfg, tickets, `moved "${ticket.title}" from ${from} to ${stage}`, by, now);
}
export function orderTickets(cfg: Config, ids: string[], by = "coordinator", now = Date.now()) {
  const tickets = readTickets(cfg), rest = tickets.filter(t => !ids.includes(t.id)).sort((a, b) => a.order - b.order);
  const named = ids.map(id => { const t = tickets.find(x => x.id === id); if (!t) throw Error(`There is no ticket ${id}.`); return t; });
  [...named, ...rest].forEach((t, i) => { t.order = i + 1; });
  save(cfg, tickets, `set the order to ${ids.join(", ")}`, by, now);
}
export const byStage = (tickets: Ticket[], stage: Stage) => tickets.filter(t => t.stage === stage).sort((a, b) => stage === "ready" ? a.order - b.order : Date.parse(b.updated) - Date.parse(a.updated));

if (import.meta.main) {
  const [verb, ...rest] = process.argv.slice(2), cfg = loadConfig();
  const flag = (name: string) => { const i = rest.indexOf(name); return i >= 0 ? rest.splice(i, 2)[1] : undefined; };
  try {
    const by = flag("--by");
    if (verb === "add") {
      const id = flag("--id"), title = flag("--title");
      if (!id || !title) throw Error("add needs --id and --title");
      addTicket(cfg, { id, title, stage: flag("--stage") as Stage | undefined, link: flag("--link"),
        brief: { job: flag("--job") ?? "", doneMeans: flag("--done") ?? "", whereToLook: flag("--where") ?? "", check: flag("--check") ?? "" } }, by);
    } else if (verb === "move") moveTicket(cfg, rest[0] ?? "", rest.slice(1).join(" ") as Stage, by);
    else if (verb === "order") orderTickets(cfg, rest, by);
    else if (verb === "ack") appendLine(files(cfg).events, { key: `ack:${Date.now()}`, at: new Date().toISOString(), type: "ack", text: `${by ?? "coordinator"} acknowledged the events so far`, quiet: true } satisfies Event);
    else if (verb !== "list") throw Error("usage: ticket.ts add|move|order|ack|list (see the top of ticket.ts)");
    for (const stage of STAGES) for (const t of byStage(readTickets(cfg), stage)) console.log(`${stage.padEnd(12)} ${t.id.padEnd(8)} ${t.title}`);
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); }
}
