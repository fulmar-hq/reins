#!/usr/bin/env bun
// The one page. Read-only: it renders state.json, which the watcher writes. No script, no controls.
// bun page.ts [--port n]   (default: page.port in the config, 4319)
import { readFileSync } from "node:fs";
import { loadConfig, type Config } from "./config";
import { KINDS, clock, count, files, percent } from "./lib";
import type { Meter } from "./meters";
import { askEnded } from "./notify";
import { showMinutes } from "./ticket";
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
const list = (items: string[], empty: string) => items.length ? `<ul>${items.map(i => `<li>${i}</li>`).join("")}</ul>` : `<p class="quiet">${esc(empty)}</p>`;
const span = (ms: number) => { const m = Math.max(0, Math.round(ms / 60000)); return m < 90 ? `${m} min` : m < 2880 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} days`; };
const link = (url: unknown) => typeof url === "string" && /^https?:\/\//.test(url) ? ` <a href="${esc(url)}" rel="noreferrer">link</a>` : "";
const chip = (label: string, tone: string) => `<span class="chip ${tone}">${esc(label)}</span>`;
const bar = (used: number | null, cap: number, tone = "info") => {
  if (used == null || !Number.isFinite(used) || !(cap > 0)) return `<span class="bar" aria-hidden="true"></span>`;
  return `<progress class="bar ${tone}" max="1" value="${Math.max(0, Math.min(1, used / cap))}" aria-hidden="true"></progress>`;
};
const health = (tone: string, text: string) => `<span class="health ${tone}"><span aria-hidden="true" class="dot"></span><span>${text}</span></span>`;
const stageTone = { ready: "neutral", building: "info", "in review": "review", "needs owner": "warn", shipped: "good" };
const paceTone = { "on track": "good", "a little over": "warn", "very over": "bad" };

export function render(s: State, now = Date.now()): string {
  const time = clock(s.timezone), at = time.at, today = time.day(now), split = s.split as Record<string, number | string>, total = Number(split.total);
  const share = (key: string) => `${key} ${total ? percent(Number(split[key]) / total) : "0%"}`;
  const ago = (from: number | null) => from === null ? "never" : `${at(from)} (${span(now - from)} ago)`;
  const meter = (m: Meter) => {
    if (m.used === null) return `<strong>${esc(m.label)}</strong> ${chip(`unknown since ${at(m.unknownSince ?? m.checkedAt)}`, "neutral")}${bar(null, 1)}<span class="quiet">${esc(m.reason)}</span>`;
    const fast = m.verdict === "too fast", runsOut = m.runsOutAt !== null && m.runsOutAt < (m.resetsAt ?? Infinity);
    const tone = m.used >= 1 || runsOut ? "bad" : fast ? "warn" : m.verdict ? "good" : "neutral";
    const verdict = fast ? `too fast, ${m.runsOutAt !== null ? `runs out ${at(m.runsOutAt)}` : "forecast to pass the limit"}` : m.verdict ?? "pace unknown";
    const status = m.used > 1 ? "over limit" : m.used === 1 ? "at limit" : verdict;
    const forecast = m.forecast;
    const usage = bar(m.used, 1, tone);
    const detail = m.detail && forecast == null ? `${m.detail} (${percent(m.used)})` : m.detail ?? `${percent(m.used)} used`;
    return `<strong>${esc(m.label)}</strong><p>${esc(detail)}</p>${chip(status, tone)}`
      + (forecast == null ? usage : `<div class="forecast-bar">${usage}<input type="range" min="0" max="1" step="any" value="${Math.max(0, Math.min(1, forecast))}" disabled aria-hidden="true"></div>`
        + `<div class="quiet">So far ${percent(m.used)} · <span class="forecast-key" aria-hidden="true"></span> Forecast ${percent(forecast)}</div>`)
      + `<span class="quiet">resets ${esc(at(m.resetsAt!))}${m.reason ? ` · last read ${esc(at(m.observedAt!))}: ${esc(m.reason)}` : ""}</span>`;
  };
  const jobInfo = (j: State["running"][number]) => [j.kind, j.provider, j.model, j.effort && `effort ${j.effort}`].filter(Boolean).map(esc).join(" · ");
  const running = (j: State["running"][number]) => `<strong>${esc(j.name)}</strong> <span class="quiet">${jobInfo(j)}</span>`
    + `<p>${esc(j.minutes ?? 0)} of ${esc(j.capMinutes)} minutes</p>${bar(j.minutes ?? 0, j.capMinutes)}`
    + `<p>${esc(count(j.tokens?.fresh))} of ${esc(count(j.capTokens))} tokens</p>${bar(j.tokens?.fresh ?? null, j.capTokens)}`;
  const prediction = (n: number | null | undefined) => n == null ? "no estimate yet" : `predicted ${showMinutes(n)} min`;
  const ticketPace = (t: State["tickets"][number]) => {
    const { elapsed, predicted, state } = t.timing ?? {};
    const detail = `<p class="quiet">${elapsed == null ? "" : `${showMinutes(elapsed)} min elapsed · `}${prediction(predicted)}</p>`;
    if (!state) return detail;
    return detail + chip(state, paceTone[state]) + (predicted === 0 ? bar(Number(elapsed! > 0), 1, paceTone[state]) : bar(elapsed!, predicted!, paceTone[state]));
  };
  const ticket = (t: State["tickets"][number]) => {
    return `<strong>${esc(t.title)}</strong>${link(t.link)}${t.stage === "shipped" ? "" : ticketPace(t)}`
      + (t.due ? `<p class="quiet">Due ${esc(t.due)}</p>` : "")
      + `<p class="quiet">${span(now - Date.parse(t.updated))} in this stage`
      + `${t.running ? ` · running: ${esc(t.running)}` : ""}${t.jobs ? ` · so far ${esc(t.minutes)} min, ${esc(count(t.tokens))} tokens over ${esc(t.jobs)} job${t.jobs > 1 ? "s" : ""}` : ""}</p>`;
  };
  const stage = (name: string) => s.tickets.filter(t => t.stage === name).sort((a, b) => name === "ready" ? a.order - b.order : Date.parse(b.updated) - Date.parse(a.updated)).slice(0, name === "shipped" ? 10 : 100);
  const shippedToday = s.tickets.filter(t => t.stage === "shipped" && time.day(Date.parse(t.updated)) === today)
    .sort((a, b) => Date.parse(b.updated) - Date.parse(a.updated))
    .map(t => `<strong>${esc(t.title)}</strong>${link(t.link)}` + (t.shipment ? `<p>${esc(t.shipment.proof)}</p>` : ""));
  const deadline = new Intl.DateTimeFormat("en", { timeZone: s.timezone, dateStyle: "medium", timeStyle: "long" });
  const needs = [...s.ownerAsks.filter(a => !("question" in a) || !askEnded(a, now)).map(a => "text" in a
    ? `${esc(a.text)} <span class="quiet">${esc(a.id ?? "")}</span>`
    : `<strong>${esc(a.question)}</strong><p>Recommendation: ${esc(a.recommendation)}</p>`
    + `<p>${a.fallback ? `If no answer by ${esc(deadline.format(a.fallback.at))}, I will ${esc(a.fallback.action)}` : "No safe default exists."}</p>`
    + `<p class="quiet">${esc(a.reason)} · asked ${span(now - Date.parse(a.at))} ago · ${esc(a.id)}</p>`
    + (a.held ? '<p class="warn">Held, not sent to the owner (daily limit).</p>' : "")), ...(s.needsYou ?? []).map(esc)];
  const watcherLate = now - s.at > 3 * 60000;
  const sections: [string, string, string?][] = [
    ["Needs you", list(needs, "Nothing needs you."), needs.length ? "attention" : ""],
    ["Running now", list(s.running.map(running), "Nothing is running.")],
    ["Tickets by stage", s.tickets.length ? s.stages.map(name => {
      const tickets = stage(name);
      return tickets.length ? `<h3>${chip(name[0]!.toUpperCase() + name.slice(1), stageTone[name] ?? "neutral")}</h3>${list(tickets.map(ticket), "")}` : "";
    }).join("") : `<p class="quiet">No tickets yet.</p>`],
    ["Shipped today", list(shippedToday, "No ticket shipped today.")
      + (s.shippedToday.length ? `<h3>Finished jobs</h3>${list(s.shippedToday.map(j => `<strong>${esc(j.name)}</strong><br><span class="quiet">${jobInfo(j)} · ${esc(Math.round(j.minutes ?? 0))} minutes · ${esc(count(j.tokens?.fresh))} tokens</span>`), "")}` : "")
      + (s.stoppedToday.length ? `<h3>Stopped today</h3>${list(s.stoppedToday.map(j => `<strong>${esc(j.name)}</strong><br><span class="warn">${esc(j.reason)}</span>`), "")}` : "")
      + `<p class="quiet">Today's usage: ${[...KINDS, "overhead"].filter(k => k !== "specialist" || Number(split.specialist) > 0).map(share).map(esc).join(" / ")} (${esc(count(total))} tokens; overhead is use outside launched jobs, where the tool records it)</p>`],
    ["Notes", list(s.notes.map(esc), "No notes yet.")],
    ["Meters", list(s.meters.map(meter), "No meter has been read yet.")],
    ["Health", list([
      health(watcherLate ? "bad" : "good", `Watcher last ran ${esc(ago(s.at))}${watcherLate ? ' <span class="bad">it should run every minute</span>' : ""}`),
      health(s.coordinatorUnresponsive ? "bad" : s.lastSeen ? "good" : "warn", `Coordinator last acted ${esc(ago(s.lastSeen || null))}${s.coordinatorUnresponsive ? ' <span class="bad">wake unanswered</span>' : ""}`),
      health(s.sending === "live" ? "good" : "warn", s.sending === "live" ? "Sending is <strong>live</strong>" : `Texts to the owner are off (dry-run).${s.fileWake === undefined ? "" : ` The coordinator wake is ${s.fileWake ? "on" : "off"}.`}`),
      ...(s.wakeWarning ? [health("bad", `<span class="bad">${esc(s.wakeWarning)}</span>`)] : []),
      ...s.expiries.map(e => {
        const ended = e.endsAt !== null && e.endsAt <= now;
        const time = e.endsAt === null ? "has no recorded time" : `${ended ? "ended" : "ends"} ${at(e.endsAt)}`;
        return health(ended ? "bad" : e.endsAt === null || e.paused || e.endsAt - now <= 3 * 3600000 ? "warn" : "good", `${esc(e.name)} ${esc(time)}${e.paused ? " (alerts paused)" : ""}`);
      }),
      ...s.errors.map(e => health("bad", `<span class="bad">${esc(e)}</span>`)),
    ], "")],
  ];
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="60"><title>Factory</title><link rel="stylesheet" href="/style.css"></head><body><main>
<h1>Factory</h1>${sections.map(([title, body, style]) => `<section${style ? ` class="${style}"` : ""}><h2>${title}</h2>${body}</section>`).join("\n")}
</main></body></html>`;
}

export const css = `:root {
  color-scheme: light;
  --bg: #f7f6f3;
  --card: #fff;
  --ink: #1b1b19;
  --quiet: #62615c;
  --line: #deddd7;
  --track: #eae9e4;
  --good: #0a5946; --good-bg: #dceee7;
  --warn: #6b4100; --warn-bg: #f5ead2;
  --bad: #8e2416; --bad-bg: #f8e1dd;
  --info: #1d4e9e; --info-bg: #dfe9f8;
  --review: #563986; --review-bg: #eee6f8;
}
@media (prefers-color-scheme: dark) { :root {
  color-scheme: dark;
  --bg: #151617;
  --card: #1f2022;
  --ink: #f2f1ed;
  --quiet: #a5a49e;
  --line: #3c3d3f;
  --track: #343638;
  --good: #8ce3c4; --good-bg: #17382e;
  --warn: #f3cd86; --warn-bg: #382c13;
  --bad: #f5a99c; --bad-bg: #40201b;
  --info: #a9cbfa; --info-bg: #17293f;
  --review: #d7c5f5; --review-bg: #322743;
} }
* { box-sizing: border-box }
body { margin: 0; background: var(--bg); color: var(--ink); font: 1rem/1.45 -apple-system, system-ui, sans-serif }
main { max-width: 70rem; margin: auto; padding: 1rem; display: grid; gap: 1rem; grid-template-columns: minmax(0, 1fr) }
@media (min-width: 48rem) {
  main { grid-template-columns: repeat(2, minmax(0, 1fr)); padding: 1.5rem }
  h1, .attention, .attention ~ section:last-child { grid-column: 1 / -1 }
}
h1 { font-size: clamp(1.75rem, 1.5rem + 1vw, 2.25rem); letter-spacing: -.035em; margin: 0 }
h2 { font-size: 1.25rem; margin: 0 0 .75rem }
h3 { margin: 1rem 0 .375rem; line-height: 1.25 }
section { background: var(--card); border: 1px solid var(--line); border-radius: 1rem; padding: 1rem; overflow-wrap: anywhere }
.attention { background: var(--warn-bg); border-color: var(--warn); padding: 1.25rem }
.attention h2 { color: var(--warn); font-size: 1.5rem }
.attention li { font-weight: 600 }
.attention .quiet { font-weight: 400 }
ul { list-style: none; margin: 0; padding: 0 }
li + li { border-top: 1px solid var(--line); padding-top: .75rem; margin-top: .75rem }
p { margin: .5rem 0 0 }
a { color: inherit; text-underline-offset: .15em }
.quiet { color: var(--quiet); font-size: .875rem }
.good { --tone: var(--good); --tint: var(--good-bg) }
.warn { --tone: var(--warn); --tint: var(--warn-bg) }
.bad { --tone: var(--bad); --tint: var(--bad-bg) }
.info { --tone: var(--info); --tint: var(--info-bg) }
.review { --tone: var(--review); --tint: var(--review-bg) }
.neutral { --tone: var(--quiet); --tint: var(--track) }
.chip { display: inline-block; background: var(--tint); color: var(--tone); border-radius: .75rem; padding: .2rem .65rem; font-size: .875rem; font-weight: 600 }
p + .chip { margin-top: .375rem }
.bar { appearance: none; display: block; width: 100%; height: .5rem; border: 0; border-radius: .25rem; overflow: hidden; background: var(--track); margin: .375rem 0 .5rem }
.bar::-webkit-progress-bar { background: var(--track) }
.bar::-webkit-progress-value { background: var(--tone); border-radius: .25rem }
.bar::-moz-progress-bar { background: var(--tone); border-radius: .25rem }
.forecast-bar { position: relative }
.forecast-bar input { appearance: none; position: absolute; inset: -.125rem 0; width: 100%; margin: 0; background: transparent; opacity: 1; pointer-events: none }
.forecast-bar input::-webkit-slider-thumb { appearance: none; width: .25rem; height: .75rem; background: var(--ink); outline: 1px solid var(--card) }
.forecast-bar input::-moz-range-thumb { width: .25rem; height: .75rem; background: var(--ink); outline: 1px solid var(--card); border: 0; border-radius: 0 }
.forecast-key { display: inline-block; width: .25rem; height: .65rem; background: var(--ink) }
.health { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: .5rem }
.dot { width: .55rem; height: .55rem; margin-top: .45rem; border-radius: 50%; background: var(--tone) }
span.warn, span.bad { color: var(--tone) }
.health { color: var(--ink) }
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
      try { return reply(render(JSON.parse(readFileSync(files(cfg).state, "utf8"))), "text/html"); }
      catch { return reply("The watcher has not written its state yet.", "text/plain", 503); }
    },
  });
  return server;
}

if (import.meta.main) {
  const at = process.argv.indexOf("--port"), server = serve(loadConfig(), at >= 0 ? Number(process.argv[at + 1]) : undefined);
  console.log(`Factory page on http://127.0.0.1:${server.port}`);
}
