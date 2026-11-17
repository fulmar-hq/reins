// Meters: one per usage window of each enabled harness, plus any extra meters from the config.
// A failed read keeps the last real value with its date and the reason, or says "unknown since". Nothing is estimated.
import { enabledProviders, type Config, type ExtraMeter } from "./config";
import { exec, pace, percent } from "./lib";
import { PROVIDERS } from "./providers";

export type Meter = {
  id: string; label: string; used: number | null; detail: string | null; start: number | null; resetsAt: number | null;
  observedAt: number | null; checkedAt: number; verdict: string | null; runsOutAt: number | null; unknownSince: number | null; reason: string | null;
};
const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export function reading(id: string, label: string, used: number, start: number | null, resetsAt: number, observedAt: number, detail: string | null = null, forecast?: number): Meter {
  const p = start === null ? null : pace(used, start, resetsAt, observedAt, forecast);
  return { id, label, used, detail, start, resetsAt, observedAt, checkedAt: observedAt, verdict: p?.verdict ?? null, runsOutAt: p?.runsOutAt ?? null, unknownSince: null, reason: null };
}
/** A failed read: the previous real values, marked with why they are old; or one "unknown since" row. */
function kept(old: Meter[], id: string, label: string, now: number, reason: string): Meter[] {
  const real = old.filter(m => m.used !== null && (m.resetsAt ?? 0) > now);
  if (real.length) return real.map(m => ({ ...m, reason, checkedAt: now }));
  return [{ id, label, used: null, detail: null, start: null, resetsAt: null, observedAt: null, checkedAt: now, verdict: null, runsOutAt: null,
    unknownSince: old.find(m => m.used === null)?.unknownSince ?? now, reason }];
}
/** The current window of a monthly (from day 1) or weekly (from Monday) limit, in UTC. */
export function window(reset: ExtraMeter["reset"], now: number) {
  const d = new Date(now), midnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  if (reset === "weekly") { const start = midnight - ((d.getUTCDay() + 6) % 7) * 86400000; return { start, end: start + 7 * 86400000 }; }
  return { start: Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1), end: Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) };
}
async function extra(m: ExtraMeter, previous: Meter[], now: number): Promise<Meter[]> {
  const id = `extra-${slug(m.name)}`, old = previous.filter(p => p.id === id), { start, end } = window(m.reset, now);
  if (old[0] && now - old[0].checkedAt < (m.everyHours ?? 1) * 3600000) return old;
  let out: any;
  try { out = JSON.parse(await exec(m.command, { timeoutMs: 30000 })); } catch { return kept(old, id, m.name, now, "its command failed or did not print JSON"); }
  if (!Number.isFinite(out?.used) || out.used < 0) return kept(old, id, m.name, now, typeof out?.reason === "string" ? out.reason.slice(0, 200) : 'its command printed no "used" number');
  const limit = out.limit > 0 ? Number(out.limit) : m.limit, unit = m.unit ?? "", amount = (n: number) => `${unit}${Number(n.toFixed(2))}`;
  const forecast = Number.isFinite(out.forecast) ? out.forecast / limit : undefined;
  return [reading(id, m.name, out.used / limit, start, end, now, `${amount(out.used)} of ${amount(limit)}${forecast === undefined ? "" : `, forecast ${amount(out.forecast)}`}`, forecast)];
}
async function harness(cfg: Config, name: ReturnType<typeof enabledProviders>[number], previous: Meter[], now: number): Promise<Meter[]> {
  const p = PROVIDERS[name], old = previous.filter(m => m.id.startsWith(`${name}-`) || m.id === name);
  const usage = await p.usage(cfg.providers[name]!).catch(() => null);
  if (!usage?.windows.length) return kept(old, name, p.label, now, `${p.label} did not report its usage`);
  return usage.windows.map(w => {
    const span = w.minutes === 10080 ? "week" : w.minutes === 300 ? "5 hours" : "limit";
    return reading(`${name}-${slug(w.name)}`, `${p.label} ${w.name.startsWith("Current ") ? w.name.slice(8) : span}`, w.used, w.minutes ? w.resetsAt - w.minutes * 60000 : null, w.resetsAt, usage.observedAt);
  });
}
export async function readMeters(cfg: Config, previous: Meter[], now: number): Promise<Meter[]> {
  return (await Promise.all([...enabledProviders(cfg).map(name => harness(cfg, name, previous, now)), ...cfg.extraMeters.map(m => extra(m, previous, now))])).flat();
}
/** One plain sentence for a meter; `at` formats a time in the configured timezone. */
export function meterLine(m: Meter, at: (ms: number) => string): string {
  if (m.used === null) return `${m.label}: unknown since ${at(m.unknownSince ?? m.checkedAt)} (${m.reason})`;
  const fast = m.runsOutAt ? `too fast, runs out ${at(m.runsOutAt)}` : "too fast, forecast to pass the limit before it resets";
  return `${m.label}: ${m.detail ? `${m.detail} (${percent(m.used)})` : `${percent(m.used)} used`}, ${m.verdict === "too fast" ? fast : m.verdict ?? "pace unknown"}`
    + (m.reason ? `, as of ${at(m.observedAt!)} because ${m.reason}` : "");
}
