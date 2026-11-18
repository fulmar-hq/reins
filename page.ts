#!/usr/bin/env bun
// The one page. Read-only: it renders state.json, which the watcher writes. No script, no controls.
// bun page.ts [--port n]   (default: page.port in the config, 4319)
import { readFileSync } from "node:fs";
import { loadConfig, type Config } from "./config";
import { clock, files, jobOutcome, jobs, percent, ticketAttempts, type Job } from "./lib";
import { window as meterWindow, type Meter } from "./meters";
import { askEnded } from "./notify";
import { byStage, type Ticket } from "./ticket";
import type { State } from "./watch";

// Access: bound to loopback only, the Host header must be exactly the loopback address (so a page on
// another site or a rebinding trick cannot read it), strict headers, and no write operation at all.
// To see it from a phone, put your own authenticated tunnel in front; never bind it to a public address.
const security = {
  "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'none'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
};
const reply = (body: string, type: string, status = 200) => new Response(body, { status, headers: { ...security, "Content-Type": `${type}; charset=utf-8` } });
export function refusal(req: Request, port: number): Response | undefined {
  if (req.headers.get("host") !== `127.0.0.1:${port}`) return reply("loopback host required", "text/plain", 403);
  if (req.method !== "GET") return reply("read-only page", "text/plain", 405);
}

const esc = (text: unknown) => String(text).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const dayMs = 86400000;
const duration = (ms: number) => {
  const m = Math.max(0, Math.round(ms / 60000));
  return m < 90 ? `${m} min` : m < 2880 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} days`;
};
const title = (t: Ticket) => t.link && /^https?:\/\//i.test(t.link)
  ? `<a href="${esc(t.link)}" rel="noreferrer">${esc(t.title)}</a>` : esc(t.title);
const dots = [
  ["late", "Late, idle"], ["late moving", "Late, running"], ["soon", "At risk"], ["idle", "On track"],
  ["todo", "Not started"],
] as const;
const dot = (tone: string) => `<span class="dot ${tone}" aria-hidden="true"></span>`;
const icon = (shape: string) => `<svg viewBox="0 0 12 12" aria-hidden="true">${shape}</svg>`;
const play = icon('<path d="M2 1l9 5-9 5z"/>');
const pause = icon('<path d="M2 1h3v10H2zM7 1h3v10H7z"/>');
const arrow = icon('<path d="M2 1v5h8M7 3l3 3-3 3"/>');
const activity = (running: boolean, label: string) => `<span class="activity${running ? "" : " paused"}">${running ? play : pause}${label === "not started" ? "" : `<span class="sr-only">${running ? "Running for " : "Paused for "}</span>`}${esc(label)}</span>`;
const section = (heading: string, body: string) => `<section><h2>${heading}</h2>${body}</section>`;
const cell = (cls: string, content: string) => `<td role="cell" class="${cls}">${content}</td>`;
function row(tone: string, name: string, { failures = 0, current = "", time = "", waiting = "", detail = "" } = {}) {
  const status = dots.find(([key]) => key === tone)?.[1] ?? "Needs you";
  const queued = tone === "todo";
  const trailing = queued ? "" : cell("failures", failures ? String(failures) : "") + cell("now", current) + cell("num", time);
  return `<tr role="row" class="row${queued ? " small" : ""}">${cell("status", dot(tone))}
<td role="cell" class="name"${queued ? ' colspan="4"' : ""}${detail ? ` title="${esc(detail)}"` : ""}><span class="sr-only">${status}. </span>${name}${waiting}</td>
${trailing}</tr>`;
}
const spanningRow = (cls: string, text: string) => `<tr role="row" class="${cls}"><td role="cell" colspan="5">${text}</td></tr>`;
function table(label: string, body: string, hideHead = false) {
  return `<table role="table" aria-label="${label}">
<thead role="rowgroup"${hideHead ? ' class="sr-only"' : ""}><tr role="row"><th scope="col" role="columnheader"><span class="sr-only">Status</span></th>
<th scope="col" role="columnheader">Ticket</th><th scope="col" role="columnheader" title="Failed in a row" aria-label="Failed in a row">Fails</th><th scope="col" role="columnheader">Now</th><th scope="col" role="columnheader">Time / predicted</th></tr></thead>
<tbody role="rowgroup">${body}</tbody></table>`;
}

function elapsedOverPredicted(elapsed: number | null, predicted: number | null) {
  const show = (minutes: number | null) => minutes === null ? "—" : duration(minutes * 60000);
  const spent = show(elapsed), expected = show(predicted);
  const [amount, unit] = spent.split(" ");
  return `${unit && expected.endsWith(" " + unit) ? amount : spent} / ${expected}`;
}

function failedInARow(ended: ReturnType<typeof ticketAttempts>) {
  let failures = 0;
  for (const attempt of ended) {
    if (attempt.achieved === undefined || (attempt.outcome === "finished" && attempt.achieved !== false)) break;
    failures++;
  }
  return failures;
}

function windowFraction(m: Meter, at: number) {
  return m.start != null && m.resetsAt != null && m.resetsAt > m.start
    ? (at - m.start) / (m.resetsAt - m.start) : null;
}

function usageMeter(m: Meter, now: number, at: (ms: number) => string) {
  const when = windowFraction(m, now);
  const reading = m.observedAt == null ? null : windowFraction(m, m.observedAt);
  const used = m.used;
  const projected = used === null ? null : m.forecast ?? (reading !== null && reading >= 0.05 ? used / reading : null);
  const over = used !== null && used >= 1;
  const runsOut = m.runsOutAt != null && m.resetsAt != null && m.runsOutAt < m.resetsAt;
  const tone = over ? " late" : runsOut || m.verdict === "too fast" || (projected ?? 0) > 1 ? " soon" : "";
  const figure = used === null ? "Unknown" : m.figure ?? m.detail?.split(", forecast ")[0] ?? percent(used);
  const date = used === null ? m.unknownSince ?? m.checkedAt : m.observedAt;
  const hint = m.reason ? `${date == null ? "" : at(date) + " · "}${m.reason}` : "";
  const position = (fraction: number) => Math.max(0, Math.min(1, fraction)) * 100 + "%";
  // SVG lengths keep the bar dynamic under the page's external-stylesheet CSP.
  const fill = (cls: string, fraction: number) => `<rect class="${cls}" y="3" width="${position(fraction)}" height="8" rx="3"/>`;
  const label = [used === null ? "Unknown" : `${percent(used)} used`,
    projected === null ? "" : `${percent(projected)} by reset`, when === null ? "" : `${percent(Math.max(0, Math.min(1, when)))} today`,
    over ? "At or over limit" : tone ? "Limit risk" : ""].filter(Boolean).join(" · ");
  const bar = `<div class="bar${tone}"><svg role="img" aria-label="${label}">${fill("track", 1)}
${projected === null ? "" : fill("projected", projected)}${used === null ? "" : fill("used", used)}
${when === null ? "" : `<rect class="tick" x="${position(when)}" width="2" height="14" rx="1"/>`}</svg></div>`;
  return `<div class="meter"${hint ? ` title="${esc(hint)}"` : ""}><span>${esc(m.label)}</span><span class="quiet">${esc(figure)}</span>${bar}</div>`;
}

export function render(s: State, now = Date.now(), ledger: readonly Job[] = []): string {
  const { at, day } = clock(s.timezone), todayDate = day(now);
  const short = new Intl.DateTimeFormat("en-US", { timeZone: s.timezone, hour: "numeric", minute: "2-digit" });
  const logTime = new Intl.DateTimeFormat("en-GB", { timeZone: s.timezone, hour: "2-digit", minute: "2-digit" });
  const updated = new Intl.DateTimeFormat("en-US", { timeZone: s.timezone, weekday: "short", hour: "numeric", minute: "2-digit" });
  const dueDay = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short" });
  const since = (ms: number) => `Nothing running since ${todayDate === day(ms) ? short.format(ms) : at(ms)}`;
  const runtime = (j: State["running"][number]) => duration(now - Date.parse(j.started));
  const latestEnd = ledger.reduce((latest, j) => j.ended ? Math.max(latest, Date.parse(j.ended)) : latest, -Infinity);
  const header = s.running.length ? `${s.running.length} job${s.running.length === 1 ? "" : "s"} running`
    : since(Number.isFinite(latestEnd) ? latestEnd : s.idleSince ?? s.at);
  const days = (due: string) => (Date.parse(due) - Date.parse(todayDate)) / dayMs;
  const asks = s.ownerAsks.filter(a => !("question" in a) || !askEnded(a, now)).map(a => row("you",
    esc("question" in a ? a.question : a.text), {
      current: `<span class="quiet">waiting ${duration(now - Date.parse(a.at))}</span>`,
      detail: "text" in a ? "" : `${a.recommendation} · ${a.fallback ? `${at(a.fallback.at)} · ${a.fallback.action}` : "No safe default"}`,
    }));

  const rows: { rank: number; html: string }[] = [];
  const work = (rank: number, name: string, columns: Parameters<typeof row>[2]) => {
    rows.push({ rank, html: row(dots[rank]![0], name, columns) });
  };
  const problem = (name: string, detail: string, rank = 0, time = "") => work(rank, esc(name), { detail, time: esc(time) });
  if (now - s.at > 3 * 60000) problem("Watcher is late", `Last ran ${at(s.at)}`, 0, duration(now - s.at));
  if (s.coordinatorUnresponsive) problem("Wake unanswered", s.lastSeen ? `Coordinator last acted ${at(s.lastSeen)}` : "No coordinator response");
  if (s.wakeWarning) problem("Wake waiting", s.wakeWarning);
  for (const error of s.errors) problem("Watcher error", error);
  if (s.backlog?.count === null) problem(`${s.backlog.label}: read failed`, `Checked ${at(s.backlog.checkedAt)}`, 0, "?");
  for (const e of s.expiries) {
    if (e.endsAt == null || e.endsAt - now > 3 * 3600000) continue;
    const over = e.endsAt <= now;
    problem(e.name, `${over ? "Ended" : "Ends"} ${at(e.endsAt)}${e.paused ? " · alerts paused" : ""}`, over ? 0 : 2,
      over ? "Expired" : duration(e.endsAt - now));
  }

  const inProgress = new Set<string>();
  for (const t of s.tickets) {
    const left = t.due ? days(t.due) : Infinity;
    if (t.stage === "shipped" || (t.stage === "ready" && left > 3)) continue;
    inProgress.add(t.id);
    const active = s.running.find(j => j.ticket === t.id);
    const ended = ticketAttempts(t.id, ledger).filter(a => a.ended && a.outcome)
      .sort((a, b) => Date.parse(b.ended!) - Date.parse(a.ended!));
    const { elapsed, predicted, state } = t.timing;
    // An older watcher state may still contain a borrowed prediction.
    const paceState = t.estimate == null ? null : state;
    const late = left < 0 || (left > 3 && paceState === "very over");
    const rank = late ? (active ? 1 : 0) : left <= 3 || paceState === "a little over" ? 2 : 3;
    const idleSince = Date.parse(ended[0]?.ended ?? t.updated);
    const current = active ? activity(true, runtime(active))
      : activity(false, t.stage === "ready" ? "not started" : duration(now - idleSince));
    const dateLabel = left === 0 ? "today" : `${Math.abs(left)} day${Math.abs(left) === 1 ? "" : "s"}${left < 0 ? " late" : ""}`;
    const estimate = t.estimate == null ? "no estimate" : elapsedOverPredicted(elapsed, predicted);
    const time = left <= 3 ? `${dueDay.format(Date.parse(t.due!))} · ${dateLabel}${t.estimate == null ? "<br>" + estimate : ""}` : estimate;
    const waiting = t.waitingOn && s.tickets.find(other => other.id === t.waitingOn);
    work(rank, title(t), { failures: failedInARow(ended), current, time,
      waiting: waiting ? `<span class="waiting">${arrow}<span class="sr-only">Waiting on </span>${title(waiting)}</span>` : "" });
  }
  for (const j of s.running.filter(j => !j.ticket))
    work(3, esc(j.name), { current: activity(true, runtime(j)), time: elapsedOverPredicted((now - Date.parse(j.started)) / 60000, j.capMinutes) });

  const { start: monday } = meterWindow("weekly", Date.parse(todayDate));
  const mondayDate = new Date(monday).toISOString().slice(0, 10);
  const shipped = s.tickets.filter(t => t.stage === "shipped" && Date.parse(t.updated) <= now && day(Date.parse(t.updated)) >= mondayDate);
  const ready = byStage(s.tickets, "ready").filter(t => !inProgress.has(t.id));
  const stat = (label: string, count: number | string) => `<span><b>${count}</b> ${esc(label)}</span>`;
  const week = `<div class="week"><span>This week</span>${stat("shipped", shipped.length)}${stat("in progress", inProgress.size)}${stat("not started", ready.length)}${s.backlog ? stat(s.backlog.label, s.backlog.count ?? "?") : ""}</div>`;
  const progress = rows.sort((a, b) => a.rank - b.rank).map(r => r.html).join("")
    + spanningRow("group", `Not started · ${ready.length}`)
    + ready.slice(0, 5).map(t => row("todo", title(t))).join("")
    + (ready.length > 5 ? spanningRow("more", `and ${ready.length - 5} more`) : "");
  const usage = s.meters.map(m => usageMeter(m, now, at)).join("");
  const usageKey = '<div class="usage-key"><span><i class="used"></i>used</span><span><i class="projected"></i>by reset</span><span><i class="tick"></i>today</span></div>';
  const news: { at: number; text: string }[] = [];
  const earliest = Date.parse(todayDate) - dayMs;
  const add = (ms: number, text: string) => { if (ms >= earliest && ms <= now && day(ms) === todayDate) news.push({ at: ms, text }); };
  for (const j of ledger) {
    add(Date.parse(j.started), `Started: ${esc(j.name)}`);
    const outcome = jobOutcome(j);
    if (j.ended && outcome) add(Date.parse(j.ended), `${outcome[0]!.toUpperCase() + outcome.slice(1)}: ${esc(j.name)}${j.reason ? `<span class="quiet"> · ${esc(j.reason)}</span>` : ""}`);
  }
  for (const t of byStage(s.tickets, "shipped"))
    add(Date.parse(t.updated), `Shipped: ${title(t)}${t.shipment ? `<span class="quiet"> · ${esc(t.shipment.proof)}</span>` : ""}`);
  for (const e of s.expiries) {
    if (e.renewedAt != null && e.endsAt != null) add(e.renewedAt, `${esc(e.name)} renewed <span class="quiet">· until ${esc(at(e.endsAt))}</span>`);
    if (e.endsAt != null) add(e.endsAt, `${esc(e.name)} ended`);
  }
  news.sort((a, b) => b.at - a.at);
  const today = news.length ? `<div class="log">${news.slice(0, 12).map(e => `<time datetime="${new Date(e.at).toISOString()}">${logTime.format(e.at)}</time><span>${e.text}</span>`).join("")}</div>`
    + (news.length > 12 ? `<p class="quiet">and ${news.length - 12} earlier</p>` : "") : '<p class="quiet">No events yet today.</p>';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta http-equiv="refresh" content="60"><title>Reins</title><link rel="stylesheet" href="/style.css"></head><body><main>
<header><h1>Reins</h1><span class="quiet" title="${esc(at(s.at))}">${esc(header)} · updated ${esc(updated.format(s.at))}</span></header>
<div class="columns"><div class="tickets">${asks.length ? section("Needs you", table("Needs you", asks.join(""), true)) : ""}${section("In progress and due soon", table("Tickets and system status", progress) + week)}</div>
<div>${section("Usage", usage ? usage + usageKey : '<p class="quiet">No readings yet.</p>')}${section("Today", today)}</div></div>
</main></body></html>`;
}

export const css = `
:root { color-scheme:light; --bg:#fbfaf8; --ink:#1c1c1a; --quiet:#6f6e68; --line:#e6e5df; --track:#e9e8e2; --idle:#c9c8c1; --red:#c8372d; --amber:#c98a00 }
@media (prefers-color-scheme: dark) {
  :root { color-scheme:dark; --bg:#151617; --ink:#efeeea; --quiet:#a3a29c; --line:#2c2d31; --track:#2c2d31; --idle:#55565c; --red:#ff6b5e; --amber:#f0b93a }
}
body { margin:0; background:var(--bg); color:var(--ink); font:16px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; overflow-wrap:anywhere }
main { max-width:1240px; margin:auto; padding:16px max(20px, env(safe-area-inset-right)) 28px max(20px, env(safe-area-inset-left)) }
header { display:flex; justify-content:space-between; align-items:baseline; flex-wrap:wrap; gap:6px 16px; margin-bottom:14px }
h1 { font-size:17px; font-weight:650; margin:0 }
h2 { font-size:13px; font-weight:600; color:var(--quiet); margin:0 0 2px }
p { margin:6px 0 0 }
a { color:inherit; text-underline-offset:.15em }
.quiet, .num { color:var(--quiet); font-size:14px }
.columns { display:grid; grid-template-columns:minmax(0,1.7fr) minmax(0,1fr); gap:36px; align-items:start }
section + section { margin-top:18px }
.week { display:flex; align-items:baseline; flex-wrap:wrap; gap:4px 22px; margin-top:16px; padding-top:10px; border-top:1px solid var(--line); font-size:14px; color:var(--quiet) }
.week b { color:var(--ink); font-weight:650; font-variant-numeric:tabular-nums }
.tickets { display:grid; grid-template-columns:16px minmax(0,1fr) max-content max-content max-content }
.tickets section, table, thead, tbody, tr { display:grid; grid-column:1/-1; grid-template-columns:subgrid }
.tickets h2, .week, .group td, .more td { grid-column:1/-1 }
th { padding:8px 10px; border-bottom:1px solid var(--ink); text-align:left; font-size:12px; font-weight:600; color:var(--quiet) }
th:first-child { padding-inline:0 }
th:nth-child(n+3), .failures, .now, .num { border-left:1px solid var(--line) }
th:nth-child(3), .failures { text-align:center }
th:nth-child(4), .now { white-space:nowrap }
th:last-child, .num { text-align:right }
th:last-child { padding-left:2px }
.row { border-bottom:1px solid var(--line) }
.row td { padding:8px 10px }
.row .status { padding-inline:0; padding-top:12px }
.row.small td { padding-block:5px }
.row.small .status { padding-top:8px }
.name { font-size:16px; font-weight:550; letter-spacing:-.01em; min-width:0 }
.small .name { grid-column:2/-1; font-size:14px; font-weight:450 }
.dot { display:block; box-sizing:border-box; width:14px; height:14px; border-radius:50%; background:var(--idle) }
.dot.late { background:var(--red) }
.dot.late.moving { background:none; border:3px solid var(--red) }
.dot.soon { background:var(--amber) }
.dot.you { background:var(--ink) }
.dot.todo { background:none; border:2px solid var(--idle) }
.failures, .now, .num { font-variant-numeric:tabular-nums }
.failures { font-weight:650; color:var(--red) }
.row .now, .row .num { font-size:14px; padding-top:9px }
@media (min-width:761px) {
  .row:has(.waiting) :is(.failures, .now, .num) { align-self:start; min-height:39px; box-sizing:border-box }
}
.activity, .waiting { display:flex; align-items:center; gap:7px }
.activity svg, .waiting svg { width:13px; height:13px; flex:none; fill:currentColor }
.activity.paused, .waiting { color:var(--quiet) }
.waiting { align-items:baseline; margin-top:2px; font-size:13px; font-weight:400 }
.waiting svg { align-self:flex-start; margin-top:2px; fill:none; stroke:currentColor; stroke-width:1.8 }
.group td { padding:14px 0 3px; border-bottom:1px solid var(--line); font-size:13px; font-weight:600; color:var(--quiet) }
.more td { padding:5px 0 0 26px; font-size:13px; color:var(--quiet) }
.meter { display:grid; grid-template-columns:minmax(0,1fr) fit-content(65%); align-items:baseline; gap:4px 12px; padding:7px 0 9px; border-bottom:1px solid var(--line); font-size:15px }
.meter .quiet { text-align:right }
.bar { position:relative; grid-column:1/-1; height:8px; --fill:var(--ink); --projection:var(--idle) }
.bar.soon { --fill:var(--amber); --projection:color-mix(in srgb, var(--amber) 45%, var(--track)) }
.bar.late { --fill:var(--red); --projection:color-mix(in srgb, var(--red) 45%, var(--track)) }
.bar svg { position:absolute; top:-3px; left:0; width:100%; height:14px; overflow:visible }
.bar .track { fill:var(--track) }
.bar .used { fill:var(--fill) }
.bar .projected { fill:var(--projection) }
.bar .tick { fill:var(--ink); transform:translateX(-1px) }
.usage-key { display:flex; flex-wrap:wrap; gap:4px 16px; padding-top:7px; font-size:12px; color:var(--quiet) }
.usage-key span { display:inline-flex; align-items:center; gap:6px }
.usage-key i { width:16px; height:8px; border-radius:2px; background:var(--ink) }
.usage-key .projected { background:var(--idle) }
.usage-key .tick { width:2px; height:12px; border-radius:1px }
.log { display:grid; grid-template-columns:auto minmax(0,1fr); gap:4px 10px; font-size:14px; padding-top:6px }
.log time { color:var(--quiet); font-variant-numeric:tabular-nums }
.sr-only { position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%); white-space:nowrap }
@media (max-width:760px) {
  .columns { grid-template-columns:minmax(0,1fr); gap:28px }
  .tickets { grid-template-columns:minmax(0,1fr) }
  .week { gap:4px 12px; font-size:13px }
  thead { position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%); white-space:nowrap }
  .row { grid-template-columns:16px minmax(0,1fr) fit-content(7rem); gap:2px 12px; align-items:baseline; padding:6px 0 }
  .row td, .row.small td { padding:0; border:0 }
  .row .status, .row.small .status { grid-area:1 / 1; align-self:start; padding-top:4px }
  .row .name { grid-area:1 / 2 }
  .row .num { grid-area:1 / 3 }
  .row .failures { grid-area:2 / 2; text-align:left }
  .row .now { grid-area:2 / 3; justify-self:end }
  .row:has(.dot.you) .now { grid-row:1 }
  .row .now, .row .num { padding-top:0 }
  .row.small .name { grid-column:2/-1 }
  .row td:empty { display:none }
  .row.small { padding-block:5px }
}
`;

export function serve(cfg: Config = loadConfig(), port = cfg.page.port) {
  const server = Bun.serve({
    hostname: "127.0.0.1", port,
    fetch(req) {
      const refused = refusal(req, server.port!);
      if (refused) return refused;
      const path = new URL(req.url).pathname;
      if (path === "/style.css") return reply(css, "text/css");
      if (path !== "/") return reply("not found", "text/plain", 404);
      try { return reply(render(JSON.parse(readFileSync(files(cfg).state, "utf8")), Date.now(), jobs(files(cfg).ledger)), "text/html"); }
      catch { return reply("The watcher has not written its state yet.", "text/plain", 503); }
    },
  });
  return server;
}

if (import.meta.main) {
  const at = process.argv.indexOf("--port"), server = serve(loadConfig(), at >= 0 ? Number(process.argv[at + 1]) : undefined);
  console.log(`Reins usage page on http://127.0.0.1:${server.port}`);
}
