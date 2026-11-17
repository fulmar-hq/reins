#!/usr/bin/env bun
// The one page. Read-only: it renders state.json, which the watcher writes. No script, no controls.
// bun page.ts [--port n]   (default: page.port in the config, 4319)
import { readFileSync } from "node:fs";
import { loadConfig, type Config } from "./config";
import { KINDS, clock, count, files, percent } from "./lib";
import type { Meter } from "./meters";
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

export function render(s: State, now = Date.now()): string {
  const at = clock(s.timezone).at, split = s.split as Record<string, number | string>, total = Number(split.total);
  const share = (key: string) => `${key} ${total ? percent(Number(split[key]) / total) : "0%"}`;
  const ago = (from: number | null) => from === null ? "never" : `${at(from)} (${span(now - from)} ago)`;
  const meter = (m: Meter) => {
    if (m.used === null) return `<strong>${esc(m.label)}</strong> <span class="warn">unknown since ${esc(at(m.unknownSince ?? m.checkedAt))}</span><br><span class="quiet">${esc(m.reason)}</span>`;
    const verdict = m.verdict === "too fast" ? `<span class="bad">too fast, ${esc(m.runsOutAt ? `runs out ${at(m.runsOutAt)}` : "forecast to pass the limit")}</span>` : `<span class="${m.verdict ? "good" : "quiet"}">${esc(m.verdict ?? "pace unknown")}</span>`;
    return `<strong>${esc(m.label)}</strong> ${esc(m.detail ? `${m.detail} (${percent(m.used)})` : `${percent(m.used)} used`)} · ${verdict}`
      + `<div class="bar"><i class="w${Math.min(20, Math.round(m.used * 20))}"></i></div>`
      + `<span class="quiet">resets ${esc(at(m.resetsAt!))}${m.reason ? ` · last read ${esc(at(m.observedAt!))}: ${esc(m.reason)}` : ""}</span>`;
  };
  const ticket = (t: State["tickets"][number]) => `<strong>${esc(t.title)}</strong>${link(t.link)}<br><span class="quiet">${esc(span(now - Date.parse(t.updated)))} in this stage`
    + `${t.running ? ` · running: ${esc(t.running)}` : ""}${t.jobs ? ` · so far ${esc(t.minutes)} min, ${esc(count(t.tokens))} tokens over ${esc(t.jobs)} job${t.jobs > 1 ? "s" : ""}` : ""}</span>`;
  const stage = (name: string) => s.tickets.filter(t => t.stage === name).sort((a, b) => name === "ready" ? a.order - b.order : Date.parse(b.updated) - Date.parse(a.updated)).slice(0, name === "shipped" ? 10 : 100);
  const needs = [...s.ownerAsks.map(a => `${esc(a.text)} <span class="quiet">${esc(at(Date.parse(a.at)))}</span>`),
    ...stage("needs owner").map(t => `${esc(t.title)}${link(t.link)}`), ...s.needsYou.map(esc)];
  const sections: [string, string][] = [
    ["Needs you", list(needs, "Nothing needs you.")],
    ["Running now", list(s.running.map(j => `<strong>${esc(j.name)}</strong> <span class="quiet">${esc(j.kind)} · ${esc(j.provider)}</span><br>${esc(Math.round(j.minutes ?? 0))} of ${esc(j.capMinutes)} minutes · ${esc(count(j.tokens?.fresh))} of ${esc(count(j.capTokens))} tokens`), "Nothing is running.")],
    ["Tickets", s.tickets.length ? s.stages.filter(name => stage(name).length).map(name => `<h3>${esc(name[0]!.toUpperCase() + name.slice(1))}</h3>${list(stage(name).map(ticket), "")}`).join("") : `<p class="quiet">No tickets yet.</p>`],
    ["Shipped today", list(s.shippedToday.map(j => `<strong>${esc(j.name)}</strong><br><span class="quiet">${esc(j.kind)} · ${esc(j.provider)} · ${esc(Math.round(j.minutes ?? 0))} minutes · ${esc(count(j.tokens?.fresh))} tokens</span>`), "No job has finished today.")
      + (s.stoppedToday.length ? `<h3>Stopped today</h3>${list(s.stoppedToday.map(j => `<strong>${esc(j.name)}</strong><br><span class="warn">${esc(j.reason)}</span>`), "")}` : "")
      + `<p class="quiet">Today's usage: ${[...KINDS, "overhead"].filter(k => k !== "specialist" || Number(split.specialist) > 0).map(share).map(esc).join(" / ")} (${esc(count(total))} tokens; overhead is use outside launched jobs, where the tool records it)</p>`],
    ["Meters", list(s.meters.map(meter), "No meter has been read yet.")],
    ["Health", list([
      `Watcher last ran ${esc(ago(s.at))}${now - s.at > 3 * 60000 ? ' <span class="bad">it should run every minute</span>' : ""}`,
      `Coordinator last acted ${esc(ago(s.lastSeen || null))}`,
      `Sending is <strong>${s.sending === "live" ? "live" : "dry-run (nothing is sent)"}</strong>`,
      ...s.expiries.map(e => `${esc(e.name)} ${e.endsAt === null ? "has no recorded time" : e.endsAt > now ? `ends ${esc(at(e.endsAt))}` : `<span class="warn">ended ${esc(at(e.endsAt))}</span>`}${e.paused ? " (alerts paused)" : ""}`),
      ...s.errors.map(e => `<span class="bad">${esc(e)}</span>`),
    ], "")],
  ];
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="60"><title>Factory</title><link rel="stylesheet" href="/style.css"></head><body><main>
<h1>Factory</h1>${sections.map(([title, body]) => `<section><h2>${title}</h2>${body}</section>`).join("\n")}
</main></body></html>`;
}

export const css = `:root{color-scheme:light dark;--bg:#f6f6f4;--card:#fff;--ink:#1c1c1a;--quiet:#63635e;--line:#e2e2dc;--good:#17663a;--warn:#8a5a00;--bad:#b3261e}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--card:#1e1e1c;--ink:#ececE6;--quiet:#a3a39b;--line:#32322e;--good:#6fcf97;--warn:#e5b454;--bad:#ff8a80}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.45 -apple-system,system-ui,sans-serif}
main{max-width:1100px;margin:0 auto;padding:16px;display:grid;gap:12px;grid-template-columns:1fr}
@media (min-width:900px){main{grid-template-columns:1fr 1fr}h1{grid-column:1/-1}}
h1{font-size:22px;margin:4px 0}h2{font-size:17px;margin:0 0 8px}h3{font-size:15px;margin:12px 0 4px}
section{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px;min-width:0;overflow-wrap:anywhere}
ul{list-style:none;margin:0;padding:0}li{padding:8px 0;border-top:1px solid var(--line)}li:first-child{border-top:0;padding-top:0}
p{margin:8px 0 0}a{color:inherit}.quiet{color:var(--quiet);font-size:14px}.good{color:var(--good)}.warn{color:var(--warn)}.bad{color:var(--bad);font-weight:600}
.bar{height:6px;background:var(--line);border-radius:3px;margin:6px 0 4px;overflow:hidden}.bar i{display:block;height:100%;background:var(--quiet)}
${[...Array(21).keys()].map(i => `.w${i}{width:${i * 5}%}`).join("")}`;

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
