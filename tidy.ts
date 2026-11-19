// Only immediate children of dedicated roots can be job work folders.
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { Config } from "./config";
import { appendLine, files, jobs, type Job } from "./lib";

type Folder = { path: string; identity: string };
type Root = Folder & { before: string[] };
export type Work = { roots: Root[]; used: Folder[] };

function folder(path: string): Folder | undefined {
  try {
    const s = lstatSync(path, { bigint: true });
    if (s.isDirectory() && realpathSync(path) === path) return { path, identity: `${s.dev}:${s.ino}:${s.birthtimeNs}` };
  } catch { /* missing or inaccessible */ }
}
export function snapshot(cfg: Config, paths: string[]): Work | undefined {
  if (!cfg.workRoots.length) return;
  const roots: Root[] = [], used: Folder[] = [];
  for (const path of cfg.workRoots) {
    const root = folder(path);
    if (!root) continue;
    const before = readdirSync(path);
    roots.push({ ...root, before });
    for (const name of before) {
      const child = join(path, name);
      if (!paths.some(p => resolve(p) === child || resolve(p).startsWith(child + sep))) continue;
      const f = folder(child);
      if (f) used.push(f);
    }
  }
  return { roots, used };
}

function candidates(cfg: Config, job: Job, ledger: Job[]) {
  const work = job.work;
  if (!work) return [];
  const found = new Map(work.used.map(f => [f.path, f]));
  for (const root of work.roots) {
    if (!cfg.workRoots.includes(root.path) || folder(root.path)?.identity !== root.identity) continue;
    // A new sibling has no reliable owner if two jobs observed this root at the same time.
    if (ledger.some(j => j.id !== job.id && (!j.ended || j.ended >= job.started)
        && j.work?.roots.some(r => r.path === root.path))) continue;
    const before = new Set(root.before);
    let current: string[];
    try { current = readdirSync(root.path); }
    catch (error) {
      log(cfg, job, root.path, { reason: String(error) });
      continue;
    }
    for (const name of current) {
      if (before.has(name)) continue;
      const f = folder(join(root.path, name));
      if (f) found.set(f.path, f);
    }
  }
  return [...found.values()].filter(f => valid(cfg, f));
}
function mayUse(job: Job, path: string) {
  if (job.event !== "started" || !job.work) return false;
  return job.work.used.some(f => f.path === path)
    || job.work.roots.some(r => r.path === dirname(path) && !r.before.includes(basename(path)));
}
function valid(cfg: Config, f: Folder) {
  return cfg.workRoots.includes(dirname(f.path)) && folder(f.path)?.identity === f.identity;
}
function log(cfg: Config, job: Job, path: string, detail: { bytes: number } | { reason: string }) {
  appendLine(files(cfg).ledger, { event: "bytes" in detail ? "removed" : "tidy-skipped", at: new Date().toISOString(),
    job: job.id, ticket: job.ticket, path, ...detail });
}
function command(argv: string[], cwd: string) {
  const run = Bun.spawnSync(argv, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_NO_REPLACE_OBJECTS: "1" }, timeout: 30000 });
  if (run.exitCode !== 0) throw Error(run.stderr.toString().trim() || `${argv[0]} failed`);
  return run.stdout.toString().trimEnd();
}
export function tidyJob(cfg: Config, job: Job, dryRun = false) {
  if (!job.work || !cfg.workRoots.length) return [];
  const ledger = jobs(files(cfg).ledger), folders = candidates(cfg, job, ledger);
  for (const f of folders) {
    try {
      if (ledger.some(j => j.id !== job.id && mayUse(j, f.path)))
        throw Error("another running job may use this folder");
      const run = Bun.spawnSync(["python3", join(import.meta.dir, "tidy-folders.py"), f.path, f.identity,
        JSON.stringify(cfg.disposableFolders), dryRun ? "preview" : "remove"]);
      for (const row of run.stdout.toString().trim().split("\n").filter(Boolean)) {
        const { path, bytes } = JSON.parse(row);
        if (dryRun) console.log("Would remove", path, bytes, "bytes");
        else log(cfg, job, path, { bytes });
      }
      if (run.exitCode !== 0) throw Error(run.stderr.toString().trim() || "could not inspect disposable folders");
    } catch (error) {
      if (dryRun) console.log("Would skip", f.path, String(error));
      else log(cfg, job, f.path, { reason: String(error) });
    }
  }
  return folders;
}
export function tidyShipped(cfg: Config, ticket: string, dryRun = false) {
  if (!cfg.workRoots.length) return;
  const ledger = jobs(files(cfg).ledger), seen = new Set<string>();
  for (const job of ledger.filter(j => j.ticket === ticket)) for (const f of job.workFolders ?? []) {
    if (seen.has(f.identity)) continue;
    seen.add(f.identity);
    try {
      if (!valid(cfg, f)) throw Error("folder changed or is outside the configured roots");
      if (ledger.some(j => mayUse(j, f.path)
        || j.ticket !== ticket && j.workFolders?.some(other => other.identity === f.identity)))
        throw Error("another job may use this folder");
      if (!lstatSync(join(f.path, ".git")).isFile()) throw Error("not a linked Git worktree");
      const git = (...args: string[]) => command(["git", ...args], f.path);
      if (git("rev-parse", "--show-toplevel") !== f.path) throw Error("not the worktree root");
      const status = () => git("status", "--porcelain", "--untracked-files=all", "--ignored", "--ignore-submodules=none");
      const requireClean = () => {
        if (git("for-each-ref", "--format=%(objectname)", "refs/stash")) throw Error("repository has a stash");
        // Git status and worktree remove can both overlook edits to these index entries.
        if (/(?:^|\0)[a-zS] /.test(git("ls-files", "-v", "-z")))
          throw Error("index marks files assume-unchanged or skip-worktree");
        if (status()) throw Error("worktree has local changes or files");
      };
      requireClean();
      const head = git("rev-parse", "HEAD");
      // Check live branch tips too: a deleted or force-pushed branch can leave a stale local tracking ref.
      const pushed = git("remote").split("\n").filter(Boolean).some(remote =>
        git("ls-remote", "--heads", remote).split("\n").some(line => {
          const tip = line.split("\t")[0];
          return !!tip && Bun.spawnSync(["git", "--no-replace-objects", "merge-base", "--is-ancestor", head, tip], { cwd: f.path }).exitCode === 0;
        }));
      if (!pushed) throw Error("commit could not be confirmed on a remote branch");
      const bytes = Number(command(["du", "-sk", "."], f.path).split(/\s/)[0]) * 1024;
      if (!Number.isFinite(bytes)) throw Error("could not measure worktree");
      if (dryRun) console.log("Would remove", f.path, bytes, "bytes");
      else {
        if (!valid(cfg, f) || git("rev-parse", "HEAD") !== head) throw Error("worktree changed during inspection");
        requireClean();
        git("worktree", "remove", f.path);
        log(cfg, job, f.path, { bytes });
      }
    } catch (error) {
      if (dryRun) console.log("Would skip", f.path, String(error));
      else log(cfg, job, f.path, { reason: String(error) });
    }
  }
}
