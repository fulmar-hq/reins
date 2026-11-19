import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config";
import { files, readLines, type Job } from "./lib";
import { diskMeter, readMeters } from "./meters";
import { pass, METER_GAP_MS } from "./watch";
import { tidyJob, workFolder } from "./tidy";

test("tidy removes only listed direct caches and worktree review is read-only", () => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "tidy-"))), root = join(tmp, "jobs");
  const config = join(tmp, "config.json"), repo = join(tmp, "repo"), outside = join(tmp, "outside");
  const tree = join(root, "job"), clean = join(root, "ready 'one'");
  writeFileSync(config, JSON.stringify({ workRoots: [root], disposableFolders: ["cache", "link", "tracked"] }));
  const cfg = loadConfig(config);
  const git = (...args: string[]) => {
    const r = Bun.spawnSync(["git", "-c", "user.name=Example", "-c", "user.email=user@example.com",
      "-c", "commit.gpgsign=false", ...args], { cwd: tmp });
    expect(r.exitCode, r.stderr.toString()).toBe(0);
  };
  git("init", "-b", "main", repo);
  git("-C", repo, "commit", "--allow-empty", "-m", "example");
  git("init", "--bare", "remote");
  git("-C", repo, "remote", "add", "origin", join(tmp, "remote"));
  git("-C", repo, "push", "origin", "main");
  for (const p of [tree, clean, outside]) git("-C", repo, "worktree", "add", "--detach", p);
  for (const p of ["cache", "nested/cache", "tracked"]) mkdirSync(join(tree, p), { recursive: true });
  mkdirSync(join(outside, "cache"));
  symlinkSync(join(outside, "cache"), join(tree, "link"));
  const tracked = join(tree, "tracked/file");
  writeFileSync(tracked, "original");
  git("-C", tree, "add", "tracked");
  writeFileSync(tracked, "pending edit");
  const job = { id: "example", cwd: workFolder(cfg, tree) } as Job;
  tidyJob(cfg, job);
  tidyJob(cfg, { ...job, cwd: workFolder({ ...cfg, workRoots: [tmp] }, outside) });
  expect(existsSync(join(tree, "cache"))).toBe(false);
  for (const p of [join(tree, "nested/cache"), join(tree, "link"), join(outside, "cache")]) expect(existsSync(p)).toBe(true);
  expect(readFileSync(tracked, "utf8")).toBe("pending edit");
  const report = Bun.spawnSync([process.execPath, join(import.meta.dir, "tidy.ts")], { cwd: tmp, env: { ...process.env, REINS_CONFIG: config } });
  expect(report.exitCode).toBe(0);
  expect(report.stdout.toString()).toContain("git worktree remove '" + clean.replaceAll("'", "'\\''") + "'");
  expect(report.stdout.toString()).toContain("Keep " + tree);
  expect(report.stdout.toString()).not.toContain(outside);
  for (const p of [tree, clean, outside]) expect(existsSync(join(p, ".git"))).toBe(true);
});

test("disk reads the fullest configured volume without a reset or forecast", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "meter-"));
  const cfg = loadConfig(join(tmp, "config.json"), { providers: {} });
  expect(await readMeters(cfg, [], 1)).toEqual([]);
  cfg.workRoots = [join(tmp, "one"), join(tmp, "two")];
  const meter = await diskMeter(cfg, [], 1, async () => "header\nvol 100 75 25 75% /\n");
  expect(meter).toMatchObject({ used: 0.75, start: null, resetsAt: null, verdict: null });
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
