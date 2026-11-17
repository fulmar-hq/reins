import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config";
import { spawn } from "node:child_process";
import { files, jobs, pace, processStarted, readLines, withLock, type Event, type Job } from "./lib";
import { send, takeNews, textOwner } from "./notify";
import { launch } from "./run";
import { batch, pass, stop } from "./watch";

const scratch = (extra: Record<string, unknown> = {}) => {
  const root = mkdtempSync(join(tmpdir(), "simple-factory-"));
  return loadConfig(join(root, "factory.config.json"), { privateDir: root, timezone: "UTC", providers: { codex: { enabled: true } }, ...extra });
};

// Rule: a job past its cap is stopped, so a runaway job cannot keep spending. Made-up job, no model.
test("a job over its cap is stopped and the ledger says why", async () => {
  const cfg = scratch(), root = cfg.privateDir, fake = join(root, "fake-harness"), prompt = join(root, "p.txt");
  writeFileSync(fake, "#!/bin/sh\necho started\nsleep 300\n"); chmodSync(fake, 0o755); writeFileSync(prompt, "made-up prompt");
  Object.assign(process.env, { SIMPLE_FACTORY_FAKE_HARNESS: fake, CODEX_SESSIONS_DIR: join(root, "none") });
  const job = await launch(cfg, { kind: "build", name: "Made-up runaway", cwd: root, prompt, capMinutes: 1 });
  const running = () => Bun.spawnSync(["ps", "-o", "pid=", "-g", String(job.pid)]).stdout.toString().trim() !== "";
  expect(running()).toBe(true);
  await pass({ cfg, now: Date.now() + 30000, meters: async () => [] });
  expect(running()).toBe(true); // under the cap: left alone
  await pass({ cfg, now: Date.now() + 2 * 60000, meters: async () => [] });
  for (let i = 0; i < 20 && running(); i++) await Bun.sleep(50); // the kernel reaps the group a moment after the signal
  expect(running()).toBe(false);
  expect(jobs(files(cfg).ledger)[0]).toMatchObject({ event: "ended", result: "stopped-cap", tokens: null, dir: job.dir });
  expect(readLines<Event>(files(cfg).events).map(e => e.type)).toEqual(["stopped-cap", "wake"]); // one event, one wake
});

// Rule: a burst never becomes a burst of wakes; one message carries everything, at most one per 5 minutes.
test("a burst of events becomes one wake", () => {
  const event = (i: number): Event => ({ key: `job:${i}`, at: "2030-01-01T00:00:00Z", type: "finished", text: `Finished: made-up job ${i}.`, dir: `/made-up/run-${i}` });
  const events = [1, 2, 3, 4, 5, 6, 7].map(event), t0 = 1_900_000_000_000;
  const first = batch(events, { delivered: 0, lastMailAt: 0 }, t0);
  expect(first.messages).toHaveLength(1);
  expect(first.messages[0]!.summary).toStartWith("7 changes.");
  for (const e of events) expect(first.messages[0]!.body).toContain(e.dir!);
  events.push(event(8));
  expect(batch(events, first.cursor, t0 + 4 * 60000).messages).toHaveLength(0); // inside the 5 minutes: held
  const later = batch(events, first.cursor, t0 + 5 * 60000);
  expect(later.messages.map(m => m.body)).toEqual(["- Finished: made-up job 8. /made-up/run-8"]);
  expect(batch(events, later.cursor, t0 + 60 * 60000).messages).toHaveLength(0); // nothing new: no wake
  events.push({ ...event(9), quiet: true });
  expect(batch(events, later.cursor, t0 + 60 * 60000).messages).toHaveLength(0); // the coordinator's own ticket moves never wake it
  const many = batch(Array.from({ length: 60 }, (_, i) => event(i)), { delivered: 0, lastMailAt: 0 }, t0);
  expect(many.messages).toHaveLength(1);
  expect(many.messages[0]!.body.length).toBeLessThanOrEqual(800);
  expect(many.messages[0]!.body).toContain("more in events.jsonl");
});

// Rule: the pace verdict is what warns the owner that a limit will run out early; its arithmetic must hold.
test("pace verdict arithmetic", () => {
  const day = 86400000, start = 0, reset = 7 * day;
  expect(pace(0.5, start, reset, 3.5 * day)).toEqual({ verdict: "on track", runsOutAt: null }); // exactly on the line
  expect(pace(0.3, start, reset, 3.5 * day)).toEqual({ verdict: "plenty left", runsOutAt: null }); // heading for 60%
  expect(pace(0.6, start, reset, 3 * day)).toEqual({ verdict: "too fast", runsOutAt: 5 * day }); // 20% a day
  expect(pace(1, start, reset, 2 * day)).toEqual({ verdict: "too fast", runsOutAt: 2 * day }); // already out
  expect(pace(0.08, start, reset, 1 * day)).toEqual({ verdict: "plenty left", runsOutAt: null }); // 8% a day ends at 56%
  expect(pace(0.04, start, reset, 0.2 * day).verdict).toBe("on track"); // first twentieth of the window: too early to call
  expect(pace(0.09, start, reset, 0.5 * day)).toEqual({ verdict: "too fast", runsOutAt: Math.round(0.5 * day / 0.09) }); // little used, but really ahead of the line
  // A forecast from the source replaces the straight line: ahead of the line but forecast under the limit is fine,
  expect(pace(0.56, start, reset, 3.5 * day, 0.86)).toEqual({ verdict: "on track", runsOutAt: null });
  expect(pace(0.4, start, reset, 3.5 * day, 1.2).verdict).toBe("too fast"); // and behind the line but forecast over is not.
});

// Rule: stopping a job must never signal a process that is not provably that job.
test("a process whose identity cannot be confirmed is never signalled", async () => {
  const bystander = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
  await new Promise(ok => bystander.once("spawn", ok));
  const job = { pid: bystander.pid!, pidStarted: "Thu Jan  1 00:00:00 2030", dir: "/made-up" } as Job; // same number, wrong start time
  stop(job);
  await Bun.sleep(150);
  expect(processStarted(bystander.pid!)).not.toBe("");
  // Leaderless: the leader has exited and left a child in its group. With no leader to confirm, nothing is signalled,
  // whether the recorded start time is right or wrong.
  const leader = spawn("sh", ["-c", "sleep 30 >/dev/null 2>&1 & echo $!"], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
  const child = Number(await new Response(leader.stdout as unknown as ReadableStream).text());
  const recorded = processStarted(leader.pid!) || "Thu Jan  1 00:00:00 2030";
  await new Promise(ok => leader.once("exit", ok));
  for (const pidStarted of [recorded, "Thu Jan  1 00:00:00 2030", ""]) stop({ pid: leader.pid!, pidStarted, dir: "/made-up" } as Job);
  await Bun.sleep(150);
  expect(processStarted(child)).not.toBe("");
  process.kill(child, "SIGKILL");
  stop({ ...job, pidStarted: processStarted(bystander.pid!) }); // a confirmed live leader: stopped
  for (let i = 0; i < 20 && processStarted(bystander.pid!); i++) await Bun.sleep(50);
  expect(processStarted(bystander.pid!)).toBe("");
});

// Rule: a lock that cannot be taken must fail in bounded time, and then the owner text is held, not sent.
test("a stuck lock times out and holds the owner text", async () => {
  const cfg = scratch({ notify: { owner: { channel: "command", command: ["/made-up/does-not-exist"] } } }), lock = files(cfg).lock;
  expect(withLock(join(cfg.privateDir, "missing", "parent", "x.lock"), () => "ran")).toBe("ran"); // missing parent folder is created
  mkdirSync(join(lock, "stuck"), { recursive: true }); utimesSync(lock, 0, 0); // stale, and not removable because it is not empty
  const started = Date.now();
  expect(() => withLock(lock, () => "ran", 200)).toThrow(/Could not take the lock/);
  expect(Date.now() - started).toBeLessThan(2000);
  const text = await textOwner(cfg, "Made-up ask?", "owner-ask", true); // waits out the default 5 seconds, then holds
  expect(text.held).toBe(true);
}, 15000);

// Rule: the owner is never texted more than the daily limit, even when two asks race or a delivery fails midway.
test("owner texts cannot exceed the daily limit", async () => {
  const cfg = scratch({ notify: { ownerMaxPerDay: 1, owner: { channel: "command", command: ["/made-up/does-not-exist"] } } });
  const both = await Promise.all([textOwner(cfg, "Made-up ask one?", "owner-ask", false), textOwner(cfg, "Made-up ask two?", "owner-ask", false)]);
  expect(both.filter(sent => !sent.held)).toHaveLength(1);
  const failing = scratch({ notify: { ownerMaxPerDay: 1, owner: { channel: "command", command: ["/made-up/does-not-exist"] } } });
  await expect(textOwner(failing, "Made-up ask?", "owner-ask", true)).rejects.toThrow(); // delivery fails after the slot was taken
  expect((await textOwner(failing, "Made-up retry?", "owner-ask", true)).held).toBe(true); // so a retry cannot slip past the limit
});

// Rule: news for the coordinator is handed over exactly once and never skipped, or a stall goes unseen.
test("coordinator news is handed over once and never lost", async () => {
  const cfg = scratch({ notify: { coordinator: { channel: "file" } } });
  const got: string[] = [], take = () => takeNews(cfg, news => { got.push(news); });
  expect(take()).toBe(false);
  await send(cfg, { to: "coordinator", summary: "first", body: "" }, true); // arrives while the coordinator is busy
  await send(cfg, { to: "coordinator", summary: "second", body: "" }, true);
  expect(take()).toBe(true); // a wait started later gets both at once
  expect(got[0]).toContain("first"); expect(got[0]).toContain("second");
  expect(take()).toBe(false); // and they are not replayed
  await send(cfg, { to: "coordinator", summary: "third", body: "" }, true);
  expect(take()).toBe(true); expect(got[1]).toMatch(/third/); expect(got).toHaveLength(2);
  expect(() => takeNews(cfg, () => { throw Error("made-up crash while writing"); })).not.toThrow(); // nothing new: deliver is not called
  await send(cfg, { to: "coordinator", summary: "fourth", body: "" }, true);
  expect(() => takeNews(cfg, () => { throw Error("made-up crash while writing"); })).toThrow(); // a crash before the output is written
  expect(take()).toBe(true); expect(got[2]).toMatch(/fourth/); // loses nothing: the next wait still gets it
  expect(readLines<Event>(files(cfg).events).filter(e => e.type === "ack")).toHaveLength(3); // only real hand-overs acknowledge
});
