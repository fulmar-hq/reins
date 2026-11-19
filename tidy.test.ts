import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadConfig } from "./config";
import { appendLine, files, readLines, type Job } from "./lib";
import { diskMeter } from "./meters";
import { pass, METER_GAP_MS } from "./watch";
import { addTicket, moveTicket } from "./ticket";
import { snapshot, tidyJob, tidyShipped } from "./tidy";

test("cleanup roots exclude broad and ambiguous paths", () => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "roots-"))), path = join(tmp, "config.json");
  for (const root of ["", "/", "relative", "~/", homedir(), dirname(homedir()), tmp + "/work/../other"]) {
    expect(() => loadConfig(path, { workRoots: [root] }), root).toThrow("workRoots");
  }
});

test("tidy stays in the job folder and preserves work until it is clean and pushed", () => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "tidy-"))), root = join(tmp, "work");
  const cfg = loadConfig(join(tmp, "config.json"), { workRoots: [root], disposableFolders: ["cache"] });
  const repo = join(tmp, "repo"), tree = join(root, "job"), outside = join(tmp, "outside");
  const git = (cwd: string, ...args: string[]) => {
    const r = Bun.spawnSync(["git", "-c", "user.name=Example", "-c", "user.email=user@example.com", "-c", "commit.gpgsign=false", ...args], { cwd });
    expect(r.exitCode, r.stderr.toString()).toBe(0);
  };
  for (const p of [repo, join(root, "older/cache"), join(outside, "cache")]) mkdirSync(p, { recursive: true });
  git(repo, "init", "-b", "main");
  git(repo, "commit", "--allow-empty", "-m", "example");
  git(tmp, "init", "--bare", "remote");
  git(repo, "remote", "add", "origin", join(tmp, "remote"));
  git(repo, "push", "origin", "main");
  const work = snapshot(cfg, [repo]);
  git(repo, "worktree", "add", "-b", "topic", tree);
  const cache = join(tree, "nested/cache"), keep = join(tree, "keep"), link = join(tree, "cache");
  mkdirSync(cache, { recursive: true });
  writeFileSync(join(cache, "data"), "example");
  writeFileSync(keep, "work in progress");
  symlinkSync(outside, link);
  const job = { id: "job", ticket: "ticket", event: "ended", work } as Job;
  tidyJob(cfg, job, true);
  expect(existsSync(cache)).toBe(true);
  job.workFolders = tidyJob(cfg, job);
  appendLine(files(cfg).ledger, job);
  expect(existsSync(cache)).toBe(false);
  for (const p of [keep, link, join(outside, "cache"), join(root, "older/cache")]) expect(existsSync(p)).toBe(true);
  tidyShipped(cfg, "ticket");
  expect(existsSync(keep)).toBe(true);
  git(tree, "add", ".");
  git(tree, "commit", "-m", "more work");
  tidyShipped(cfg, "ticket");
  expect(existsSync(tree)).toBe(true);
  git(tree, "push", "origin", "topic");
  writeFileSync(keep, "edited tracked file");
  tidyShipped(cfg, "ticket");
  expect(existsSync(keep)).toBe(true);
  git(tree, "stash", "push", "-m", "pending local work");
  tidyShipped(cfg, "ticket");
  expect(existsSync(tree)).toBe(true);
  git(tree, "stash", "pop");
  git(tree, "restore", "keep");

  for (const flag of ["assume-unchanged", "skip-worktree"]) {
    git(tree, "update-index", "--" + flag, "keep");
    writeFileSync(keep, "local edit hidden from status");
    tidyShipped(cfg, "ticket");
    expect(existsSync(keep)).toBe(true);
    git(tree, "update-index", "--no-" + flag, "keep");
    git(tree, "restore", "keep");
  }
  git(tree, "switch", "--detach", "main");
  git(tree, "commit", "--allow-empty", "-m", "detached work");
  tidyShipped(cfg, "ticket");
  expect(existsSync(tree)).toBe(true);
  git(tree, "push", "origin", "HEAD:refs/heads/reviewed-detached");
  git(tree, "switch", "topic");
  // Delete on the remote directly so the local remote-tracking ref is stale.
  git(join(tmp, "remote"), "update-ref", "-d", "refs/heads/topic");
  tidyShipped(cfg, "ticket");
  expect(existsSync(tree)).toBe(true);
  git(tree, "push", "origin", "topic");
  tidyShipped(cfg, "ticket", true);
  expect(existsSync(tree)).toBe(true);
  addTicket(cfg, { id: "ticket", title: "Example work", estimate: 10,
    brief: { job: "example", doneMeans: "example", whereToLook: "example", check: "example" } });
  moveTicket(cfg, "ticket", "shipped", "coordinator", Date.now(), "checked");
  expect(existsSync(tree)).toBe(false);
  const removed = readLines<{ event: string; path: string; bytes: number }>(files(cfg).ledger).filter(r => r.event === "removed");
  expect(removed.map(r => r.path)).toEqual([cache, tree]);
  expect(removed.every(r => r.bytes > 0)).toBe(true);
});

test("disk reads the fullest configured volume without a reset or forecast", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "meter-"));
  const cfg = loadConfig(join(tmp, "config.json"), { providers: {} });
  const meter = await diskMeter(cfg, [], 1, async args => {
    expect(args).toEqual(["df", "-Pk", tmp]);
    return "Filesystem 1024-blocks Used Available Capacity Mounted on\nvol 100 75 25 75% /\n";
  });
  expect(meter).toMatchObject({ used: 0.75, label: "Disk on this machine", start: null, resetsAt: null, verdict: null });
  cfg.workRoots = [join(tmp, "one"), join(tmp, "two")];
  const full = await diskMeter(cfg, [], 2, async args => {
    expect(args.slice(2)).toEqual(cfg.workRoots);
    return "header\na 100 25 75 25% /a\nb 100 90 10 90% /b with spaces\n";
  });
  expect(full.used).toBe(0.9);
  cfg.diskAlarmPercent = 85;
  let now = METER_GAP_MS;
  for (const m of [meter, full, full, meter, full]) {
    await pass({ cfg, now, meters: async () => [{ ...m, observedAt: now, checkedAt: now }] });
    now += METER_GAP_MS;
  }
  const alarms = readLines<{ type: string; text: string }>(files(cfg).events).filter(e => e.type === "meter");
  expect(alarms).toHaveLength(2);
  expect(alarms.every(a => a.text.includes("85%"))).toBe(true);
  expect(await diskMeter(cfg, [full], 3, async () => "bad")).toMatchObject({ used: 0.9, observedAt: 2, checkedAt: 3 });
});
