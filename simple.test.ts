import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, readFileSync, renameSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { loadConfig } from "./config";
import { spawn } from "node:child_process";
import { appendLine, files, jobs, pace, processStarted, readLines, ticketAttempts, withLock, type Event, type Job } from "./lib";
import { send, takeNews, textOwner, updateAsk } from "./notify";
import { reading } from "./meters";
import { render } from "./page";
import { launch, plan } from "./run";
import { addTicket, moveTicket, readTickets, ticketTimings } from "./ticket";
import { batch, pass, stop, type State } from "./watch";

function assertPrivateDir(root: string, privateDir: string) {
  const local = relative(root, privateDir);
  if (isAbsolute(local) || local === ".." || local.startsWith(".." + sep))
    throw Error("Test config resolved outside its temporary folder");
}

const scratch = (extra: Record<string, unknown> = {}) => {
  const root = mkdtempSync(join(tmpdir(), "reins-"));
  const cfg = loadConfig(join(root, "reins.config.json"), { timezone: "UTC", providers: { codex: { enabled: true } }, ...extra });
  assertPrivateDir(root, cfg.privateDir);
  return cfg;
};
const sampleAsk = ["Can you sign in again?", "Renew the existing sign-in.", "sign-in or credential", "--no-safe-default"];

async function completedPass(options: Parameters<typeof pass>[0]): Promise<State> {
  const state = await pass(options);
  if (!state) throw Error("Expected the watcher to complete the pass");
  return state;
}

test("a config loaded from another folder never touches the folder named by the environment", () => {
  const root = mkdtempSync(join(tmpdir(), "reins-config-"));
  const explicit = join(root, "explicit"), inherited = join(root, "inherited");
  const path = join(explicit, "reins.config.json");
  mkdirSync(explicit);
  writeFileSync(path, '{"timezone":"UTC","providers":{}}');
  const previous = process.env.REINS_PRIVATE_DIR;
  process.env.REINS_PRIVATE_DIR = inherited;
  try {
    const cfg = loadConfig(path);
    assertPrivateDir(root, cfg.privateDir);
    expect(cfg.privateDir).toBe(explicit);
    addTicket(cfg, { id: "local", title: "Check this folder", estimate: 15 });
    expect(readTickets(cfg)).toHaveLength(1);
    expect(existsSync(inherited)).toBe(false);
  } finally {
    if (previous === undefined) delete process.env.REINS_PRIVATE_DIR;
    else process.env.REINS_PRIVATE_DIR = previous;
  }
});

test("the privacy check scans author and committer identities throughout the commit range", () => {
  const { privateDir: root } = scratch();
  const config = join(root, "reins.config.json"), terms = join(root, "terms.txt");
  const privateWord = "Widgetmaker";
  writeFileSync(terms, privateWord);
  writeFileSync(config, JSON.stringify({ privacyTermsFile: terms }));
  assertPrivateDir(root, loadConfig(config).privateDir);
  const email = (host: string) => `git@${host}`;
  const git = (args: string[], identity = {}) => {
    const result = Bun.spawnSync(["git", "-c", "core.hooksPath=/dev/null", ...args], { cwd: root, env: {
      ...process.env, GIT_AUTHOR_NAME: "Example Author", GIT_AUTHOR_EMAIL: email("example.com"),
      GIT_COMMITTER_NAME: "Example Committer", GIT_COMMITTER_EMAIL: email("example.com"), ...identity,
    } });
    expect(result.exitCode).toBe(0);
    return result.stdout.toString().trim();
  };
  const commit = (identity?: Record<string, string>) => git(["commit", "--allow-empty", "--no-gpg-sign", "-m", "Test commit"], identity);
  git(["init", "--quiet"]);
  commit();
  const base = git(["rev-parse", "HEAD"]);
  commit({
    GIT_AUTHOR_NAME: `Example ${privateWord}`, GIT_AUTHOR_EMAIL: email("machine.LOCAL"),
    GIT_COMMITTER_NAME: `${privateWord} Example`, GIT_COMMITTER_EMAIL: email(["machine", "lan"].join(".")),
  });
  const first = git(["rev-parse", "--short=8", "HEAD"]);
  const privateEmail = email(`${privateWord}.home`);
  commit({ GIT_AUTHOR_EMAIL: privateEmail, GIT_COMMITTER_EMAIL: privateEmail });
  const second = git(["rev-parse", "--short=8", "HEAD"]);
  commit();
  const result = Bun.spawnSync([process.execPath, "--no-env-file", join(import.meta.dir, "privacy-check.ts"), `${base}..HEAD`], {
    cwd: root, env: { ...process.env, REINS_CONFIG: config },
  });
  expect(result.exitCode).toBe(1);
  const output = result.stdout.toString();
  for (const role of ["author", "committer"]) {
    expect(output).toContain(`${first} ${role} name  private word from your list`);
    expect(output).toContain(`${first} ${role} email  private email host`);
    expect(output).toContain(`${second} ${role} email  private word from your list`);
    expect(output).toContain(`${second} ${role} email  private email host`);
  }
  expect(output).toContain("8 possible private items");
  expect(output.toLowerCase()).not.toContain(privateWord.toLowerCase());
});

// Rule: a job past its cap is stopped, so a runaway job cannot keep spending. Made-up job, no model.
test("a job over its cap is stopped and the ledger says why", async () => {
  const cfg = scratch(), root = cfg.privateDir, fake = join(root, "fake-harness"), prompt = join(root, "p.txt");
  const workRoot = realpathSync(root), cwd = join(workRoot, "checkout"), cache = join(cwd, "node_modules");
  mkdirSync(cache, { recursive: true });
  cfg.workRoots = [workRoot];
  writeFileSync(join(cwd, ".env"), `REINS_PRIVATE_DIR="${root}"\nREINS_CONFIG="${join(root, "reins.config.json")}"\n`);
  writeFileSync(fake, '#!/bin/sh\nprintf "%s:%s\\n" "${REINS_PRIVATE_DIR-unset}" "${REINS_CONFIG-unset}"\n(trap "" TERM; exec sleep 300) &\nwait\n'); chmodSync(fake, 0o755); writeFileSync(prompt, "made-up prompt");
  Object.assign(process.env, { REINS_FAKE_HARNESS: fake, CODEX_SESSIONS_DIR: join(root, "none") });
  const job = await (async () => {
    Object.assign(process.env, { REINS_PRIVATE_DIR: root, REINS_CONFIG: join(root, "reins.config.json") });
    try { return await launch(cfg, { kind: "build", name: "Made-up runaway", cwd, prompt, capMinutes: 1 }); }
    finally { delete process.env.REINS_PRIVATE_DIR; delete process.env.REINS_CONFIG; }
  })();
  expect(readFileSync(join(job.dir, "prompt.txt"), "utf8")).toContain('exactly "VERDICT: DONE"');
  const running = () => Bun.spawnSync(["ps", "-o", "pid=", "-g", String(job.pid)]).stdout.toString().trim() !== "";
  expect(running()).toBe(true);
  const log = () => readFileSync(join(job.dir, "log.txt"), "utf8");
  for (let i = 0; i < 20 && !log().includes("unset:unset"); i++) await Bun.sleep(50);
  await pass({ cfg, now: Date.now() + 30000, meters: async () => [] });
  expect(running()).toBe(true); // under the cap: left alone
  await pass({ cfg, now: Date.now() + 2 * 60000, meters: async () => [] });
  for (let i = 0; i < 20 && running(); i++) await Bun.sleep(50); // the kernel reaps the group a moment after the signal
  expect(running()).toBe(false);
  expect(existsSync(cache)).toBe(false);
  expect(log()).toContain("unset:unset");
  expect(jobs(files(cfg).ledger)[0]).toMatchObject({ event: "ended", result: "stopped-cap", outcome: "capped", achieved: null, tokens: null, dir: job.dir });
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

test("meter alarms rearm on usage recovery and ignore forecast swings", async () => {
  const cfg = scratch({ providers: {} }), start = Date.parse("2030-01-01T00:00:00Z");
  const gap = 15 * 60000, reset = start + 86400000;
  let now = start + 12 * 3600000;
  const alarms = () => readLines<Event>(files(cfg).events).filter(e => e.type === "meter" || e.type === "too-fast");
  const check = async (used: number, forecast: number, unavailable = false) => {
    const sample = reading("example", "Example meter", used, start, reset + (now % (3 * gap)), now, null, forecast);
    await pass({ cfg, now, meters: async () => unavailable ? [] : [sample] });
    now += gap;
    return alarms().map(e => e.type);
  };
  expect(await check(0.49, 0.9)).toEqual([]);
  expect(await check(0.5, 1.1)).toEqual(["meter", "too-fast"]);
  expect(await check(0.5, 0.9)).toEqual(["meter", "too-fast"]);
  expect(await check(0.2, 0.9, true)).toEqual(["meter", "too-fast"]);
  expect(await check(0.51, 1.2)).toEqual(["meter", "too-fast"]);
  expect(await check(0.5, 1.3)).toEqual(["meter", "too-fast"]);
  await check(0.49, 0.9);
  expect(await check(0.51, 1.1)).toEqual(["meter", "too-fast", "meter"]);

  await check(0.49, 0.9);
  const priorAlarms = alarms().length;
  const paths = files(cfg), previousState = readFileSync(paths.state, "utf8"), previousEvents = readFileSync(paths.events, "utf8");
  const abandoned = Bun.spawnSync([process.execPath, "--no-env-file", "-e",
    'import { tryLock } from "./lib"; if (!tryLock(process.argv[1]!)) process.exit(1);',
    paths.passLock], { cwd: import.meta.dir });
  expect(abandoned.exitCode).toBe(0);
  expect(existsSync(paths.passLock)).toBe(true);

  const meter = Promise.withResolvers<ReturnType<typeof reading>[]>();
  let readingMeter = false, newerReadMeter = false;
  const older = pass({ cfg, now, meters: () => { readingMeter = true; return meter.promise; } });
  try {
    expect(readingMeter).toBe(true); // The abandoned lock was recovered.
    utimesSync(paths.passLock, 0, 0);
    const newer = await pass({ cfg, now: now + 1, meters: async () => {
      newerReadMeter = true;
      return [reading("example", "Example meter", 0.8, start, reset, now + 1)];
    } });
    expect(newer).toBeUndefined();
    expect(newerReadMeter).toBe(false);
    expect(readFileSync(paths.state, "utf8")).toBe(previousState);
    expect(readFileSync(paths.events, "utf8")).toBe(previousEvents);
  } finally {
    meter.resolve([reading("example", "Example meter", 1, start, reset, now)]);
    expect((await older)?.meterAlarms.example).toMatchObject({ used: 1, observedAt: now });
  }
  expect(alarms().slice(priorAlarms).map(e => e.text.split(". ")[0])).toEqual(["Example meter passed 100%"]);
  now += gap + 1;
  await check(0.49, 0.9);
  await check(0.5, 0.9);
  await check(0.8, 0.9);
  await check(1, 0.9);
  expect(alarms().slice(priorAlarms + 1).filter(e => e.type === "meter").map(e => e.text.split(". ")[0]))
    .toEqual(["Example meter passed 50%", "Example meter passed 80%", "Example meter passed 100%"]);
});

test("ticket, launch and wait commands complete while a meter read is pending", async () => {
  const cfg = scratch(), root = cfg.privateDir, config = join(root, "reins.config.json");
  const prompt = join(root, "prompt.txt"), harness = join(root, "fake-harness");
  writeFileSync(config, JSON.stringify(cfg));
  writeFileSync(prompt, "Made-up prompt");
  writeFileSync(harness, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const cli = (script: string, ...args: string[]) => {
    const result = Bun.spawnSync([process.execPath, "--no-env-file", join(import.meta.dir, script), ...args], {
      cwd: root, env: { ...process.env, REINS_CONFIG: config, REINS_FAKE_HARNESS: harness },
      stdout: "pipe", stderr: "pipe", timeout: 6500,
    });
    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
    return result.stdout.toString();
  };
  await send(cfg, { to: "coordinator", summary: "News ready to take", body: "" }, false);

  const meter = Promise.withResolvers<ReturnType<typeof reading>[]>();
  const entered = Promise.withResolvers<void>();
  const watching = completedPass({ cfg, meters: () => { entered.resolve(); return meter.promise; } });
  try {
    await entered.promise;
    cli("ticket.ts", "add", "--id", "example", "--title", "Check the lock", "--estimate", "15");
    cli("run.ts", "--kind", "build", "--name", "Check the lock", "--cwd", root, "--prompt", prompt, "--ticket", "example");
    expect(cli("wait.ts")).toContain("News ready to take");
    expect(existsSync(files(cfg).state)).toBe(false);
  } finally {
    meter.resolve([]);
    await watching;
  }
  const state = await watching;
  expect(state.tickets).toMatchObject([{ id: "example", stage: "building", running: "Check the lock" }]);
  expect(state.running).toMatchObject([{ ticket: "example" }]);
}, 25000);

test("a pass finishing after its successor preserves the newer state and alarms", async () => {
  const cfg = scratch({ providers: {} }), f = files(cfg), now = Date.parse("2030-01-01T10:00:00Z");
  const meter = Promise.withResolvers<ReturnType<typeof reading>[]>();
  const entered = Promise.withResolvers<void>();
  const older = pass({ cfg, now, meters: () => { entered.resolve(); return meter.promise; } });
  try {
    await entered.promise;
    // Simulate displacement of the old lock so both passes can reach the publication check.
    renameSync(f.passLock, f.passLock + ".displaced");
    await completedPass({ cfg, now: now + 1, meters: async () =>
      [reading("example", "Example meter", 0.8, null, now + 3600000, now + 1)] });
    const newerState = readFileSync(f.state, "utf8"), newerEvents = readFileSync(f.events, "utf8");
    meter.resolve([reading("example", "Example meter", 1, null, now + 3600000, now)]);
    expect(await older).toBeUndefined();
    expect(readFileSync(f.state, "utf8")).toBe(newerState);
    expect(readFileSync(f.events, "utf8")).toBe(newerEvents);
  } finally {
    meter.resolve([]);
    await older;
  }
});

test("a lock survives a different timezone and can be recovered while its exited owner is unreaped", async () => {
  const cfg = scratch(), lock = files(cfg).passLock, pidFile = join(cfg.privateDir, "child-pid");
  const parent = Bun.spawn(["python3", "-c", [
    "import os, sys",
    "pid = os.fork()",
    "if pid == 0:",
    "    os.execv(sys.argv[1], sys.argv[1:])",
    "with open(sys.argv[-1], 'w') as f:",
    "    f.write(str(pid))",
    "sys.stdin.read()",
    "try: os.kill(pid, 9)",
    "except ProcessLookupError: pass",
    "os.waitpid(pid, 0)",
  ].join("\n"), process.execPath, "--no-env-file", "-e",
  'import { tryLock } from "./lib"; if (!tryLock(process.argv[1]!)) process.exit(1); setInterval(() => {}, 1000);',
  lock, pidFile], { cwd: import.meta.dir, env: { ...process.env, TZ: "Pacific/Honolulu" }, stdin: "pipe", stdout: "ignore", stderr: "inherit" });
  try {
    let pid = "";
    for (let i = 0; i < 100 && !(pid && existsSync(lock)); i++) {
      await Bun.sleep(20);
      if (existsSync(pidFile)) pid = readFileSync(pidFile, "utf8");
    }
    expect(pid).toMatch(/^\d+$/);
    expect(existsSync(lock)).toBe(true);
    const contender = Bun.spawnSync([process.execPath, "--no-env-file", "-e",
      'import { tryLock } from "./lib"; if (tryLock(process.argv[1]!)) process.exit(1);', lock],
    { cwd: import.meta.dir, env: { ...process.env, TZ: "UTC" } });
    expect(contender.exitCode).toBe(0);

    process.kill(Number(pid), "SIGKILL");
    let state = "";
    for (let i = 0; i < 100 && !state.startsWith("Z"); i++) {
      await Bun.sleep(20);
      state = Bun.spawnSync(["ps", "-p", pid, "-o", "stat="]).stdout.toString().trim();
    }
    expect(state).toMatch(/^Z/);
    expect(existsSync(lock)).toBe(true);
    expect(withLock(lock, () => "recovered", 200)).toBe("recovered");
  } finally {
    parent.stdin.end();
    await parent.exited;
  }
});

// Rule: the pace verdict is what warns the owner that a limit will run out early; its arithmetic must hold.
test("pace verdict arithmetic", async () => {
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

  const cfg = scratch({ providers: {} }), now = 4 * day;
  const meters = [
    reading("steady", "Steady", 0.3, start, reset, 3 * day),
    reading("ahead", "Ahead", 0.7, start, reset, 3 * day),
    reading("full", "Full", 1, start, reset, now),
  ];
  const html = render(await completedPass({ cfg, now, meters: async () => meters }), now);
  expect(html).toContain('aria-label="30% used · 70% by reset · 57% today"');
  expect(html).toContain('class="bar soon"');
  expect(html).toContain('class="bar late"');
  for (const phrase of ["runs out", "heading to", "of the week", "too fast", "on track"]) expect(html).not.toContain(phrase);
});

test("ticket pace boundaries exclude time in needs owner", () => {
  const cfg = scratch(), f = files(cfg), start = Date.parse("2030-01-01T12:00:00Z"), minute = 60000;
  addTicket(cfg, { id: "demo", title: "Check the menu", estimate: 10 }, undefined, start);
  const job = { ticket: "demo", started: new Date(start).toISOString() } as Job;
  moveTicket(cfg, "demo", "needs owner", undefined, start + 2 * minute);
  moveTicket(cfg, "demo", "building", undefined, start + 8 * minute);
  const timing = (minutes: number) => ticketTimings(readTickets(cfg), [job], readLines<Event>(f.events), start + minutes * minute).get("demo");
  expect(ticketTimings(readTickets(cfg), [], readLines<Event>(f.events), start + 7 * minute).get("demo"))
    .toEqual({ elapsed: null, predicted: 10, state: null });
  expect(timing(7)).toMatchObject({ elapsed: 2, state: "on track" });
  expect(timing(16)).toMatchObject({ elapsed: 10, state: "on track" });
  expect(timing(16.01)).toMatchObject({ state: "a little over" });
  expect(timing(21)).toMatchObject({ elapsed: 15, state: "a little over" });
  expect(timing(21.01)).toMatchObject({ state: "very over" });
});

test("a ticket without an estimate is never late by pace", async () => {
  const cfg = scratch(), now = Date.parse("2030-01-08T15:00:00Z"), minute = 60000;
  const job = (ticket: string, start: number) => ({ ticket, started: new Date(start).toISOString() } as Job);
  const shipped = [1, 2, 3].map(i => {
    const id = `shipped-${i}`, start = now - 120 * minute;
    addTicket(cfg, { id, title: `Past delivery ${i}`, estimate: 10 }, "test", start);
    moveTicket(cfg, id, "shipped", "test", start + 10 * minute, "Checked");
    return job(id, start);
  });
  addTicket(cfg, { id: "legacy", title: "Pack the model", stage: "building" }, "test", now - 60 * minute);
  const timing = ticketTimings(readTickets(cfg), [...shipped, job("legacy", now - 60 * minute)],
    readLines<Event>(files(cfg).events), now).get("legacy");
  expect(timing).toEqual({ elapsed: 60, predicted: null, state: null });

  const state = await completedPass({ cfg, now, meters: async () => [] });
  const oldState = { ...state, tickets: state.tickets.map(t => t.id === "legacy"
    ? { ...t, timing: { elapsed: 60, predicted: 10, state: "very over" as const } } : t) };
  const row = render(oldState, now);
  expect(row).toContain('class="dot idle"');
  expect(row).toContain("no estimate");
  const due = render({ ...oldState, tickets: oldState.tickets.map(t => t.id === "legacy" ? { ...t, due: "2030-01-07" } : t) }, now);
  expect(due).toContain('class="dot late"');
  expect(due).toContain("Mon · 1 day late<br>no estimate");

  const add = (...args: string[]) => Bun.spawnSync([process.execPath, join(import.meta.dir, "ticket.ts"),
    "add", "--id", "new", "--title", "Start another model", ...args], {
    env: { ...process.env, REINS_CONFIG: join(cfg.privateDir, "reins.config.json") },
  });
  expect(add().exitCode).toBe(1);
  expect(add("--estimate", "20").exitCode).toBe(0);
  expect(readTickets(cfg).find(t => t.id === "new")?.estimate).toBe(20);
});

test("shipping a ticket is refused without proof", () => {
  const cfg = scratch();
  addTicket(cfg, { id: "demo", title: "Check the menu" });
  const ship = (...args: string[]) => Bun.spawnSync([process.execPath, join(import.meta.dir, "ticket.ts"), "move", "demo", "shipped", ...args], {
    env: { ...process.env, REINS_PRIVATE_DIR: cfg.privateDir, REINS_CONFIG: join(cfg.privateDir, "reins.config.json") },
  });
  expect(ship().exitCode).toBe(1);
  expect(ship("--proof", " ").exitCode).toBe(1);
  expect(readTickets(cfg)[0]?.stage).toBe("ready");
  expect(ship("--proof", "Opened the menu on the test page.").exitCode).toBe(0);
  const shipped = readTickets(cfg)[0]!;
  expect(shipped.shipment?.proof).toBe("Opened the menu on the test page.");
});

test("setting an older ticket can add an estimate, set or clear a due date, and rename it", () => {
  const cfg = scratch({ providers: {} }), root = cfg.privateDir;
  const minute = 60000, start = Date.now() - 20 * minute;
  addTicket(cfg, { id: "older", title: "Sketch a map", stage: "building" }, "test", start);
  addTicket(cfg, { id: "source", title: "Trace the path" });
  // Older stage changes identified the ticket by title alone.
  const events = files(cfg).events;
  writeFileSync(events, "");
  const stage = (minutes: number, text: string) => appendLine(events, {
    key: `legacy:${minutes}`, type: "ticket", at: new Date(start + minutes * minute).toISOString(), text: `test ${text}`,
  } satisfies Event);
  stage(5, 'moved "Sketch a map" from building to needs owner');
  stage(15, 'moved "Sketch a map" from needs owner to building');
  const config = join(root, "reins.config.json");
  writeFileSync(config, '{"providers":{}}');
  assertPrivateDir(root, loadConfig(config).privateDir);
  const set = (...args: string[]) => Bun.spawnSync([process.execPath, "--no-env-file", join(import.meta.dir, "ticket.ts"),
    "set", "older", ...args], { cwd: root, env: { ...process.env, REINS_CONFIG: config } }).exitCode;
  expect(set("--estimate", "0", "--title", "Unused title")).toBe(1);
  expect(set("--due", "2030-02-30")).toBe(1);
  expect(readTickets(cfg)[0]?.title).toBe("Sketch a map");
  expect(set("--estimate", "25", "--due", "2030-02-28", "--title", "Draw a map", "--waiting-on", "source")).toBe(0);
  expect(readTickets(cfg)[0]).toMatchObject({ title: "Draw a map", estimate: 25, due: "2030-02-28", waitingOn: "source" });
  expect(readLines<Event>(events).at(-1)).toMatchObject({
    ticket: "older", previousTitle: "Sketch a map", quiet: true,
    text: 'coordinator updated "Sketch a map" (title "Draw a map"; estimate 25 min; due 2030-02-28; waiting on source)',
  });
  const job = { ticket: "older", started: new Date(start).toISOString() } as Job;
  expect(ticketTimings(readTickets(cfg), [job], readLines<Event>(events), start + 20 * minute).get("older"))
    .toEqual({ elapsed: 10, predicted: 25, state: "on track" });
  expect(set("--estimate", "45", "--due", "none", "--title", " Draw a map ", "--waiting-on", "none")).toBe(0);
  expect(readTickets(cfg)[0]?.due).toBeUndefined();
  expect(readTickets(cfg)[0]?.estimate).toBe(45);
  expect(readTickets(cfg)[0]?.waitingOn).toBeUndefined();
  expect(readLines<Event>(events).at(-1)?.text)
    .toBe('coordinator updated "Draw a map" (estimate 45 min; due removed; waiting on removed)');
});

// Rule: stopping a job must never signal a process that is not provably that job.
test("the watcher never accepts its own process group as a job", async () => {
  const child = Bun.spawn([process.execPath, "--no-env-file", "-e", [
    'import { isOurLeader, processStarted } from "./lib";',
    'const started = processStarted(process.pid);',
    'process.exit(started && !isOurLeader(process.pid, started) ? 0 : 1);',
  ].join("\n")], { cwd: import.meta.dir, detached: true });
  expect(await child.exited).toBe(0);
});

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
test("a stuck lock times out without accepting or texting an ask", async () => {
  const cfg = scratch({ notify: { owner: { channel: "command", command: ["/made-up/does-not-exist"] } } }), lock = files(cfg).lock;
  expect(withLock(join(cfg.privateDir, "missing", "parent", "x.lock"), () => "ran")).toBe("ran"); // missing parent folder is created
  mkdirSync(join(lock, "stuck"), { recursive: true }); utimesSync(lock, 0, 0); // stale, and not removable because it is not empty
  const started = Date.now();
  expect(() => withLock(lock, () => "ran", 200)).toThrow(/Could not take the lock/);
  expect(Date.now() - started).toBeLessThan(2000);
  await expect(textOwner(cfg, sampleAsk, true)).rejects.toThrow(/Could not take the lock/);
  expect(readLines(files(cfg).events)).toHaveLength(0);
}, 15000);

// Rule: the owner is never texted more than the daily limit, even when two asks race or a delivery fails midway.
test("owner texts cannot exceed the daily limit", async () => {
  const cfg = scratch({ notify: { ownerMaxPerDay: 1, owner: { channel: "command", command: ["/made-up/does-not-exist"] } } });
  const both = await Promise.all([textOwner(cfg, sampleAsk, false), textOwner(cfg, sampleAsk, false)]);
  expect(both.filter(sent => !sent.held)).toHaveLength(1);
  const failing = scratch({ notify: { ownerMaxPerDay: 1, owner: { channel: "command", command: ["/made-up/does-not-exist"] } } });
  expect((await textOwner(failing, sampleAsk, true)).outcome).toStartWith("failed:"); // delivery fails after the slot was taken
  expect((await textOwner(failing, sampleAsk, true)).held).toBe(true);
});

test("an ask without the required parts is refused", async () => {
  const cfg = scratch();
  await expect(textOwner(cfg, ["Can you sign in again?"], false)).rejects.toThrow("recommendation");
  expect(readLines(files(cfg).events)).toHaveLength(0);
});

test("an expired ask leaves the list and the coordinator is told to take the default", async () => {
  const cfg = scratch({ providers: {} }), now = Date.now();
  const deadline = new Date(now + 60000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const ask = await textOwner(cfg, ["Should the menu open on hover?", "Keep it click-only.", "product taste", deadline, "keep it click-only"], false, now);
  expect((await completedPass({ cfg, meters: async () => [], now })).ownerAsks).toHaveLength(1);
  const state = await completedPass({ cfg, meters: async () => [], now: now + 60000 });
  expect(state.ownerAsks).toHaveLength(0);
  expect(state.notes[0]).toContain("default due");
  expect(state.notes[0]).toContain("The coordinator has been told.");
  expect(state.notes[0]).not.toContain("default taken");
  let wake = "";
  expect(takeNews(cfg, text => { wake = text; })).toBe(true);
  expect(wake).toContain("take the default now: keep it click-only");
  updateAsk(cfg, "resolved", ask.key, "Kept it click-only.", now + 60001);
  expect((await completedPass({ cfg, meters: async () => [], now: now + 60001 })).notes[0]).toContain("default taken");
  expect(() => updateAsk(cfg, "resolved", ask.key, "Kept it click-only.", now + 60002)).toThrow();
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

test("waiting news is reported until the coordinator takes it", async () => {
  const cfg = scratch({ notify: { unansweredMinutes: 2 } });
  await send(cfg, { to: "coordinator", summary: "Made-up finish", body: "" }, false);
  const now = Date.now(), watch = (minutes: number) => completedPass({ cfg, now: now + minutes * 60000, meters: async () => [] });
  expect((await watch(1)).wakeWarning).toBeNull();
  const state = await watch(3);
  expect(render(state, state.at)).toContain('title="News has been waiting 3 minutes; nobody is listening: start bun wait.ts"');
  expect(takeNews(cfg, () => {})).toBe(true);
  const next = await watch(4);
  expect(next.wakeWarning).toBeNull();
  expect(next.lastTaken).toBeGreaterThanOrEqual(now);
});

test("ticket attempts preserve launch order, retry links and older ledger outcomes", () => {
  const ledger = files(scratch()).ledger, started = "2030-01-01T09:00:00Z", ended = "2030-01-01T09:10:00Z";
  appendLine(ledger, { event: "started", id: "first", name: "First pass", kind: "build", ticket: "demo", started });
  appendLine(ledger, { event: "ended", id: "second", name: "Second pass", kind: "review", ticket: "demo",
    started: ended, ended: "2030-01-01T09:20:00Z", minutes: 10, tokens: null, purpose: "retry", retryOf: "first", outcome: "finished", reason: "result written" });
  appendLine(ledger, { event: "ended", id: "first", name: "First pass", kind: "build", ticket: "demo", started, ended,
    minutes: 10, tokens: null, result: "stopped-cap", reason: "minute cap reached" });
  appendLine(ledger, { event: "ended", id: "other", ticket: "other", started, ended, result: "finished" });
  const attempts = ticketAttempts("demo", jobs(ledger));
  expect(attempts.map(({ id, purpose, outcome, retryOf, why }) => ({ id, purpose, outcome, retryOf, why }))).toEqual([
    { id: "first", purpose: "build", outcome: "capped", retryOf: null, why: "minute cap reached" },
    { id: "second", purpose: "retry", outcome: "finished", retryOf: "first", why: "result written" },
  ]);
});

test("a very over ticket is stuck unless a job is running on it", async () => {
  const cfg = scratch(), now = Date.parse("2030-01-01T10:00:00Z"), started = new Date(now - 60 * 60000).toISOString();
  addTicket(cfg, { id: "demo", title: "Trace a route", stage: "building", estimate: 20 }, "test", Date.parse(started));
  const job = { event: "ended", id: "first", ticket: "demo", kind: "build", name: "Check route", started,
    ended: new Date(now - 60000).toISOString(), result: "stopped-cap", reason: "minute cap reached" } as Job;
  appendLine(files(cfg).ledger, job);
  const state = await completedPass({ cfg, now, meters: async () => [] });
  expect(render(state, now, [job])).toContain('class="sr-only">Late, idle. </span>Trace a route');
  const running = { ...job, model: null, effort: null, id: "second", started: new Date(now - 60000).toISOString(), ended: null, minutes: 1,
    event: "started", result: null, reason: null } as const;
  expect(render({ ...state, running: [running] }, now, [job, running])).toContain('class="sr-only">Late, running. </span>Trace a route');
});

test("Needs you is absent with no open asks", async () => {
  const now = Date.parse("2030-01-01T10:00:00Z"), state = await completedPass({ cfg: scratch(), now, meters: async () => [] });
  expect(render(state, now)).not.toContain("Needs you");
});

test("the header uses the pause icon and elapsed time until jobs run", async () => {
  const cfg = scratch({ providers: {} }), start = Date.parse("2030-01-01T10:00:00Z");
  const watch = (now: number) => completedPass({ cfg, now, meters: async () => [] });
  await watch(start);
  const now = start + 17 * 60000, state = await watch(now);
  const header = (html: string) => html.match(/<header>.*?<\/header>/)?.[0];
  expect(header(render(state, now))).toMatch(/class="activity paused"><svg.*?Paused for <\/span>17 min/);
  const running = { ticket: null, started: new Date(now).toISOString(), name: "Check a model", capMinutes: 30 } as State["running"][number];
  expect(header(render({ ...state, running: [running, running] }, now))).toContain("2 jobs running");
});

test("a ticket due within 3 days appears as an at-risk row even when not started", async () => {
  const cfg = scratch(), now = Date.parse("2030-01-01T10:00:00Z");
  addTicket(cfg, { id: "source", title: "Collect feedback" }, "test", now);
  addTicket(cfg, { id: "draft", title: "Draft guide", estimate: 30, due: "2030-01-04", waitingOn: "source" }, "test", now);
  addTicket(cfg, { id: "later", title: "Publish guide", due: "2030-01-05" }, "test", now);
  const state = await completedPass({ cfg, now, meters: async () => [] });
  const html = render(state, now);
  const row = html.match(/<tr role="row" class="row">[^]*?Draft guide[^]*?<\/tr>/)?.[0];
  expect(row).toContain('class="dot soon"');
  expect(row).toContain("not started");
  expect(row).toContain("Fri · 3 days");
  expect(row).toContain('class="waiting"><svg');
  expect(row).toContain("Collect feedback");
  expect(html.match(/Draft guide/g)).toHaveLength(1);
  expect(html).toContain("Not started · 2");
});

test("failed in a row skips redirects and unknown verdicts and resets only after DONE", async () => {
  const cfg = scratch(), now = Date.parse("2030-01-01T10:00:00Z");
  addTicket(cfg, { id: "demo", title: "Check the index", stage: "building" }, "test", now - 60000);
  const state = await completedPass({ cfg, now, meters: async () => [] });
  const attempt = (id: number, outcome: Job["outcome"], achieved?: Job["achieved"]) => ({
    id: String(id), ticket: "demo", kind: "build", name: "Check", event: outcome ? "ended" : "started", outcome, achieved,
    started: new Date(now - 60000 + id * 1000).toISOString(), ended: outcome ? new Date(now - 50000 + id * 1000).toISOString() : null,
  } as Job);
  const older = attempt(1, "failed", null), oldRow = attempt(2, "stopped"), notDone = attempt(3, "finished", false);
  const stopped = attempt(4, "stopped", null), capped = attempt(5, "capped"), active = attempt(7, null);
  const failures = (ledger: Job[]) => render(state, now, ledger).match(/class="failures">(.*?)<\/td>/)?.[1];
  expect(failures([older, oldRow, notDone, stopped, capped, active])).toBe("5");
  expect(failures([older, oldRow, notDone, stopped, capped, attempt(6, "finished", true), active])).toBe("");
  expect(failures([notDone, attempt(4, "finished", null), attempt(5, "finished"), capped])).toBe("2");

  const processToStop = Bun.spawn(["sleep", "30"], { detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  try {
    const config = join(cfg.privateDir, "reins.config.json");
    writeFileSync(config, '{"providers":{}}');
    assertPrivateDir(cfg.privateDir, loadConfig(config).privateDir);
    appendLine(files(cfg).ledger, { ...active, provider: "codex", dir: cfg.privateDir,
      pid: processToStop.pid, pidStarted: processStarted(processToStop.pid) });
    const result = Bun.spawnSync([process.execPath, "--no-env-file", join(import.meta.dir, "run.ts"),
      "stop", active.id, "--reason", "redirected"], { env: { ...process.env, REINS_CONFIG: config } });
    expect(result.exitCode).toBe(0);
    expect(await processToStop.exited).toBeDefined();
    const [redirected] = jobs(files(cfg).ledger);
    expect(redirected).toMatchObject({ outcome: "stopped", reasonKind: "redirected" });
    expect(failures([older, notDone, capped, redirected!])).toBe("3");
  } finally {
    if (processToStop.exitCode === null && processToStop.signalCode === null) processToStop.kill();
  }
});

test("the week starts at Monday midnight in the configured timezone", async () => {
  const cfg = scratch({ timezone: "America/Los_Angeles" }), now = Date.parse("2030-01-07T08:30:00Z");
  const first = Date.parse("2030-01-07T07:59:59Z"), monday = Date.parse("2030-01-07T08:00:00Z");
  addTicket(cfg, { id: "old", title: "Previous shipment" }, "test", first - 1000);
  moveTicket(cfg, "old", "shipped", "test", first, "Checked");
  addTicket(cfg, { id: "new", title: "Current shipment" }, "test", first - 1000);
  moveTicket(cfg, "new", "shipped", "test", monday, "Checked");
  addTicket(cfg, { id: "due", title: "Imminent delivery", due: "2030-01-09" }, "test", first);
  addTicket(cfg, { id: "active", title: "Active delivery" }, "test", first);
  for (let i = 1; i <= 5; i++) addTicket(cfg, { id: `queued-${i}`, title: `Queued delivery ${i}` }, "test", first);
  const state = await completedPass({ cfg, now, meters: async () => [] });
  const active: State["running"][number] = {
    id: "active-job", name: "Check delivery", kind: "investigation", provider: "codex", model: null, effort: null, ticket: "active",
    started: new Date(monday).toISOString(), ended: null, minutes: 30, capMinutes: 60, capTokens: 500000,
    tokens: null, result: null, reason: null, dir: cfg.privateDir,
  };
  const html = render({ ...state, running: [active], errors: ["Example watcher error"] }, now);
  expect(html).toMatch(/Active delivery<\/td>\s*<td[^]*?class="activity"><svg[^]*?Running for /);
  expect(html).toContain('<div class="week"><span>This week</span><span><b>1</b> shipped</span><span><b>2</b> in progress</span><span><b>5</b> not started</span>');
  expect(html.indexOf("This week")).toBeGreaterThan(html.indexOf("Not started · 5"));
  expect(html.match(/Queued delivery [1-5]/g)).toHaveLength(3);
  expect(html).toContain("and 2 more");
  expect(html).not.toContain("Shipped this week");
  expect(html).toContain("Shipped: Current shipment");
  expect(html).not.toContain("Previous shipment");
});

// Rule: the costly model is used only when the coordinator asks for it; every other job gets the everyday one.
test("a job gets the everyday model unless a tier is asked for", () => {
  const cfg = scratch({ providers: { codex: { enabled: true, model: "everyday", effort: "medium", tiers: { hard: { model: "top" }, review: { effort: "high" } } } } });
  const base = { name: "x", cwd: tmpdir(), prompt: import.meta.path };
  expect(plan(cfg, { ...base, kind: "build" })).toMatchObject({ model: "everyday", effort: "medium" });
  expect(plan(cfg, { ...base, kind: "review" })).toMatchObject({ model: "everyday", effort: "high" });
  expect(plan(cfg, { ...base, kind: "build", tier: "hard" })).toMatchObject({ model: "top", effort: "medium" });
  expect(() => plan(cfg, { ...base, kind: "build", tier: "nope" })).toThrow("no tier");
});
