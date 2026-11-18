#!/usr/bin/env bun
// The one page. Read-only: it renders state.json, which the watcher writes. No script, no controls.
// bun page.ts [--port n]   (default: page.port in the config, 4319)
import { readFileSync } from "node:fs";
import { loadConfig, type Config } from "./config";
import { clock, files, jobOutcome, jobs, percent, ticketAttempts, type Job } from "./lib";
import { askEnded } from "./notify";
import { byStage, showMinutes, type Ticket } from "./ticket";
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
const dots = [["late", "Late and stuck"], ["late moving", "Late but moving"], ["soon", "At risk"], ["idle", "On track"]] as const;
const dot = (tone: string) => `<span class="dot ${tone}" aria-hidden="true"></span>`;
const row = (tone: string, name: string, figure: string, detail: string, status = "") =>
  `<div class="row">${dot(tone)}<span class="name">${status ? `<span class="sr-only">${status}. </span>` : ""}${name}</span><span class="num">${esc(figure)}</span>${detail}</div>`;
const fact = (text: string) => `<span class="why">${esc(text)}</span>`;
const section = (heading: string, body: string) => `<section><h2>${heading}</h2>${body}</section>`;

function attemptFacts(attempts: ReturnType<typeof ticketAttempts>) {
  const retries = attempts.filter(a => a.purpose === "retry").length;
  const count = `${attempts.length} attempt${attempts.length === 1 ? "" : "s"}`
    + (retries ? `, ${retries} retr${retries === 1 ? "y" : "ies"}` : "");
  const ended = attempts.filter(a => a.outcome).sort((a, b) => Date.parse(b.ended!) - Date.parse(a.ended!));
  const latest = ended[0];
  if (!latest) return count;
  const change = ended.findIndex(a => a.outcome !== latest.outcome);
  const same = ended.slice(0, change < 0 ? ended.length : change);
  const reasons = [...new Set(same.map(a => a.why).filter(Boolean))];
  const last = same.length === 1 ? "one" : same.length === 2 ? "two" : same.length;
  const prior = same.length === 1 ? ended[1] : undefined;
  return `${count} · last ${last} ${latest.outcome}${reasons.length ? `: ${reasons.join(" / ")}` : ""}`
    + (prior ? ` · before that, ${prior.outcome}${prior.why ? `: ${prior.why}` : ""}` : "");
}

export function render(s: State, now = Date.now(), ledger: readonly Job[] = []): string {
  const { at, day } = clock(s.timezone), todayDate = day(now);
  const short = new Intl.DateTimeFormat("en-US", { timeZone: s.timezone, hour: "numeric", minute: "2-digit" });
  const logTime = new Intl.DateTimeFormat("en-GB", { timeZone: s.timezone, hour: "2-digit", minute: "2-digit" });
  const date = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });
  const since = (ms: number) => `Nothing running since ${todayDate === day(ms) ? short.format(ms) : at(ms)}`;
  const running = (j: State["running"][number]) => `Running: ${j.name}, ${showMinutes((s.at - Date.parse(j.started)) / 60000)} min`;
  const latestEnd = ledger.reduce((latest, j) => j.ended ? Math.max(latest, Date.parse(j.ended)) : latest, -Infinity);
  const header = s.running.length ? `${s.running.length} job${s.running.length === 1 ? "" : "s"} running`
    : since(Number.isFinite(latestEnd) ? latestEnd : s.idleSince ?? s.at);
  const days = (due: string) => (Date.parse(due) - Date.parse(todayDate)) / dayMs;
  const nearest = s.tickets.filter(t => t.due && t.stage !== "shipped").sort((a, b) => a.due!.localeCompare(b.due!))[0];
  let goal = "";
  if (nearest) {
    const left = days(nearest.due!), waiting = nearest.waitingOn && s.tickets.find(t => t.id === nearest.waitingOn);
    goal = `<section class="goal" aria-label="Nearest deadline">
<div class="days${left < 0 ? " overdue" : ""}">${Math.abs(left)}<small>day${Math.abs(left) === 1 ? "" : "s"} ${left < 0 ? "late" : "left"}</small></div>
<div class="what">${title(nearest)}</div>
<div class="quiet">Due ${date.format(Date.parse(nearest.due!))} · ${nearest.stage === "ready" ? "not started" : nearest.stage}${waiting ? ` · waiting on <b>${title(waiting)}</b>` : ""}</div></section>`;
  }

  const asks = s.ownerAsks.filter(a => !("question" in a) || !askEnded(a, now)).map(a => row("you",
    esc("question" in a ? a.question : a.text), `waiting ${duration(now - Date.parse(a.at))}`,
    "text" in a ? "" : fact(`Recommendation: ${a.recommendation}`)
      + fact(a.fallback ? `Default by ${at(a.fallback.at)}: ${a.fallback.action}` : "No safe default.")));

  const rows: { rank: number; html: string }[] = [];
  const work = (rank: number, name: string, figure: string, detail: string) => {
    const [tone, status] = dots[rank]!;
    rows.push({ rank, html: row(tone, name, figure, detail, status) });
  };
  const problem = (name: string, why: string, rank = 0, figure = "") => work(rank, esc(name), figure, fact(why));
  if (now - s.at > 3 * 60000) problem("Watcher is late", `Last ran ${at(s.at)}. It should run every minute.`, 0, duration(now - s.at));
  if (s.coordinatorUnresponsive) problem("Wake unanswered", s.lastSeen ? `Coordinator last acted ${at(s.lastSeen)}.` : "The coordinator has yet to respond.");
  if (s.wakeWarning) problem("Wake waiting", s.wakeWarning);
  for (const error of s.errors) problem("Watcher error", error);
  for (const e of s.expiries) {
    if (e.endsAt == null || e.endsAt - now > 3 * 3600000) continue;
    const over = e.endsAt <= now;
    problem(e.name, `${over ? "Ended" : "Ends"} ${at(e.endsAt)}${e.paused ? " · alerts paused" : ""}`, over ? 0 : 2,
      over ? "Expired" : `in ${duration(e.endsAt - now)}`);
  }

  for (const t of s.tickets) {
    if (t.stage === "ready" || t.stage === "shipped") continue;
    const attempts = ticketAttempts(t.id, ledger), active = s.running.filter(j => j.ticket === t.id);
    const { elapsed, predicted, state } = t.timing, left = t.due ? days(t.due) : Infinity;
    const late = state === "very over" || left < 0;
    const rank = late ? (active.length ? 1 : 0) : state === "a little over" || left <= 3 ? 2 : 3;
    const figure = t.stage === "needs owner" ? `waiting ${duration(now - Date.parse(t.updated))}`
      : elapsed === null ? (predicted === null ? "Pace unknown" : `0 min of ${duration(predicted * 60000)}`)
      : predicted === null ? `${duration(elapsed * 60000)} elapsed`
      : `${duration(elapsed * 60000)} of ${duration(predicted * 60000)}`;
    const ends = attempts.flatMap(a => a.ended ? [Date.parse(a.ended)] : []);
    const current = active.length ? active.map(running).join(" · ") : since(ends.length ? Math.max(...ends) : Date.parse(t.updated));
    const due = left <= 3 ? ` · due ${date.format(Date.parse(t.due!))}` : "";
    work(rank, title(t), figure, `<span class="why"><b>${esc(current)}.</b> ${esc(attemptFacts(attempts) + due)}</span>`);
  }
  for (const j of s.running.filter(j => !j.ticket))
    work(3, esc(j.name), `${duration((s.at - Date.parse(j.started)))} of ${duration(j.capMinutes * 60000)}`, `<span class="why"><b>${esc(running(j))}.</b></span>`);
  const progress = rows.sort((a, b) => a.rank - b.rank).map(r => r.html).join("") || '<p class="quiet">Nothing in progress.</p>';
  const key = `<div class="key">${dots.map(([tone, label]) => `<span>${dot(tone)}${label}</span>`).join("")}</div>`;

  const usage = s.meters.map(m => {
    const over = (m.used ?? 0) >= 1, runsOut = m.runsOutAt !== null && m.resetsAt !== null && m.runsOutAt < m.resetsAt;
    const tone = over || runsOut || (m.forecast ?? 0) > 1 ? "late" : m.verdict === "too fast" ? "soon" : "";
    let figure = m.used === null ? `Unknown since ${at(m.unknownSince ?? m.checkedAt)}` : m.detail
      ?? (`${percent(m.used)} used` + (m.forecast == null ? "" : ` · forecast ${percent(m.forecast)}`));
    if (over) figure += m.used === 1 ? " · at limit" : " · over limit";
    else if (runsOut) figure += ` · runs out ${at(m.runsOutAt!)}`;
    else if (m.verdict === "too fast") figure += " · too fast";
    if (m.reason) figure += ` · ${m.observedAt == null ? "" : `as of ${at(m.observedAt)} · `}${m.reason}`;
    return `<div class="meter"><span>${esc(m.label)}</span><span class="quiet">${esc(figure)}</span>${m.used === null ? ""
      : `<progress class="${tone}" max="1" value="${Math.max(0, Math.min(1, m.used))}" aria-hidden="true"></progress>`}</div>`;
  }).join("");
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
  const ready = byStage(s.tickets, "ready");
  const next = ready.length ? `<ol>${ready.slice(0, 5).map(t => `<li>${title(t)}</li>`).join("")}</ol>`
    + (ready.length > 5 ? `<p class="quiet">and ${ready.length - 5} more</p>` : "") : '<p class="quiet">No tickets ready.</p>';

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta http-equiv="refresh" content="60"><title>Reins</title><link rel="stylesheet" href="/style.css"></head><body><main>
<header><h1>Reins</h1><span class="quiet">${esc(header)} · updated ${esc(at(s.at))}</span></header>
<div class="columns"><div>${goal}${asks.length ? section("Needs you", asks.join("")) : ""}${section("In progress", progress + key)}</div>
<div>${section("Usage", usage || '<p class="quiet">No readings yet.</p>')}${section("Today", today)}${section("Next", next)}</div></div>
</main></body></html>`;
}

export const css = `
:root { color-scheme: light; --bg:#fafafa; --ink:#191919; --quiet:#626262; --line:#dedede; --track:#e4e4e4; --idle:#858585; --red:#b52e25; --amber:#a16a00 }
@media (prefers-color-scheme: dark) {
  :root { color-scheme:dark; --bg:#151515; --ink:#eee; --quiet:#adadad; --line:#363636; --track:#333; --idle:#818181; --red:#ff7266; --amber:#efb841 }
}
body { margin:0; background:var(--bg); color:var(--ink); font:16px/1.4 -apple-system, system-ui, sans-serif; overflow-wrap:anywhere }
main { max-width:1160px; margin:auto; padding:22px max(20px, env(safe-area-inset-right)) 40px max(20px, env(safe-area-inset-left)) }
header { display:flex; justify-content:space-between; align-items:baseline; flex-wrap:wrap; gap:6px 16px; margin-bottom:22px }
h1 { font-size:17px; margin:0 }
h2 { font-size:13px; font-weight:600; color:var(--quiet); margin:0 0 2px }
p { margin:6px 0 0 }
a { color:inherit; text-underline-offset:.15em }
.quiet, .why, .num { color:var(--quiet); font-size:14px }
.columns { display:grid; grid-template-columns:minmax(0,1.85fr) minmax(0,1fr); gap:52px; align-items:start }
section + section { margin-top:28px }
.goal { display:grid; grid-template-columns:auto minmax(0,1fr); align-items:center; gap:4px 18px; padding:14px 0; border-block:1px solid var(--line) }
.days { grid-row:span 2; font-size:44px; line-height:1; font-weight:700; text-align:center }
.days small { display:block; font-size:13px; font-weight:550; margin-top:4px }
.overdue { color:var(--red) }
.what { font-size:20px; font-weight:600 }
.row { display:grid; grid-template-columns:16px minmax(0,1fr) auto; gap:2px 14px; padding:13px 0; border-bottom:1px solid var(--line) }
.name { font-size:18px; font-weight:550 }
.why { grid-column:2/-1 }
b { color:var(--ink); font-weight:550 }
.dot { box-sizing:border-box; width:14px; height:14px; border-radius:50%; background:var(--idle) }
.row .dot { margin-top:6px }
.dot.late { background:var(--red) }
.dot.late.moving { background:none; border:3px solid var(--red) }
.dot.soon { background:var(--amber) }
.dot.you { background:var(--ink) }
.num { text-align:right; font-variant-numeric:tabular-nums; padding-top:3px; max-width:10rem }
.key { display:flex; gap:8px 20px; flex-wrap:wrap; margin-top:12px; color:var(--quiet); font-size:13px }
.key > span { display:inline-flex; gap:7px; align-items:center }
.key .dot { width:11px; height:11px }
.meter { display:grid; grid-template-columns:minmax(0,1fr) fit-content(65%); gap:4px 12px; padding:9px 0; border-bottom:1px solid var(--line); font-size:15px }
.meter .quiet { text-align:right }
progress { appearance:none; grid-column:1/-1; width:100%; height:4px; border:0; border-radius:4px; background:var(--track); overflow:hidden; --fill:var(--ink) }
progress.late { --fill:var(--red) }
progress.soon { --fill:var(--amber) }
progress::-webkit-progress-bar { background:var(--track) }
progress::-webkit-progress-value { background:var(--fill) }
progress::-moz-progress-bar { background:var(--fill) }
.log { display:grid; grid-template-columns:auto minmax(0,1fr); gap:7px 12px; font-size:14px; padding-top:6px }
.log time { color:var(--quiet); font-variant-numeric:tabular-nums }
ol { margin:0; padding-left:22px; font-size:15px }
li { padding:4px 0 }
.sr-only { position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%); white-space:nowrap }
@media (max-width:760px) { .columns { grid-template-columns:minmax(0,1fr); gap:28px } .days { font-size:36px } }
@media (max-width:400px) { .row { column-gap:8px } .num { max-width:7rem } }
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
