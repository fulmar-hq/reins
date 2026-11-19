import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";
import type { Config } from "./config";
import { appendLine, files, jobs, type Job } from "./lib";

export type Folder = { path: string; identity: string };
export const folderReport = "work-folders.txt";

export function workFolder(cfg: Config, path: string): Folder | undefined {
  if (!cfg.workRoots.some(root => path.startsWith(root + sep)) || cfg.workRoots.includes(path)) return;
  try {
    const s = lstatSync(path, { bigint: true });
    if (s.isDirectory() && realpathSync(path) === path) return { path, identity: `${s.dev}:${s.ino}:${s.birthtimeNs}` };
  } catch { /* missing or inaccessible */ }
}
function valid(cfg: Config, f: Folder) {
  return workFolder(cfg, f.path)?.identity === f.identity;
}
function reportedFolders(cfg: Config, job: Job) {
  const found = new Map<string, Folder>();
  if (job.cwd) found.set(job.cwd.path, job.cwd);
  const fd = openSync(join(job.dir, folderReport), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!fstatSync(fd).isFile()) throw Error("work folder report is not a regular file");
    for (const path of readFileSync(fd, "utf8").split(/\r?\n/)) {
      const f = workFolder(cfg, path);
      if (f && !found.has(path)) found.set(path, f);
    }
  } finally { closeSync(fd); }
  return [...found.values()];
}
function sharesFolder(cfg: Config, job: Job, f: Folder) {
  const known = job.event === "started" && job.cwd !== undefined ? reportedFolders(cfg, job) : job.ownedFolders;
  return known?.some(other => valid(cfg, other) && (other.identity === f.identity ||
    other.path.startsWith(f.path + sep) || f.path.startsWith(other.path + sep)));
}
type Detail = { bytes: number } | { reason: string };
function record(cfg: Config, job: Job, dryRun: boolean, path: string, detail: Detail) {
  if (dryRun) {
    if ("bytes" in detail) console.log("Would remove", path, detail.bytes, "bytes");
    else console.log("Would skip", path, detail.reason);
  } else appendLine(files(cfg).ledger, { event: "bytes" in detail ? "removed" : "tidy-skipped",
    at: new Date().toISOString(), job: job.id, ticket: job.ticket, path, ...detail });
}
function command(argv: string[], cwd: string) {
  const run = Bun.spawnSync(argv, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_NO_REPLACE_OBJECTS: "1" }, timeout: 30000 });
  if (run.exitCode !== 0) throw Error(run.stderr.toString().trim() || `${argv[0]} failed`);
  return run.stdout.toString().trimEnd();
}
export function tidyJob(cfg: Config, job: Job, dryRun = false) {
  if (job.cwd === undefined || !cfg.workRoots.length) return [];
  let folders: Folder[];
  try { folders = reportedFolders(cfg, job); }
  catch (error) {
    record(cfg, job, dryRun, job.dir, { reason: String(error) });
    return [];
  }
  const ledger = jobs(files(cfg).ledger);
  for (const f of folders) {
    try {
      if (!valid(cfg, f)) throw Error("folder changed or is outside the configured roots");
      if (ledger.some(j => j.id !== job.id && j.event === "started" && sharesFolder(cfg, j, f)))
        throw Error("another running job may use this folder");
      const run = Bun.spawnSync(["python3", join(import.meta.dir, "tidy-folders.py"), f.path, f.identity,
        JSON.stringify(cfg.disposableFolders), dryRun ? "preview" : "remove"]);
      for (const row of run.stdout.toString().trim().split("\n").filter(Boolean)) {
        const { path, ...detail }: { path: string } & Detail = JSON.parse(row);
        record(cfg, job, dryRun, path, detail);
      }
      if (run.exitCode !== 0) throw Error(run.stderr.toString().trim() || "could not inspect disposable folders");
    } catch (error) {
      record(cfg, job, dryRun, f.path, { reason: String(error) });
    }
  }
  return folders;
}
export function tidyShipped(cfg: Config, ticket: string, dryRun = false) {
  if (!cfg.workRoots.length) return;
  const ledger = jobs(files(cfg).ledger), seen = new Set<string>();
  for (const job of ledger.filter(j => j.ticket === ticket)) for (const f of job.ownedFolders ?? []) {
    if (seen.has(f.identity)) continue;
    seen.add(f.identity);
    try {
      if (!valid(cfg, f)) throw Error("folder changed or is outside the configured roots");
      if (ledger.some(j => (j.event === "started" || j.ticket !== ticket) && sharesFolder(cfg, j, f)))
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
      if (!dryRun) {
        if (git("rev-parse", "HEAD") !== head) throw Error("worktree changed during inspection");
        requireClean();
        if (!valid(cfg, f)) throw Error("worktree moved during inspection");
        git("worktree", "remove", f.path);
      }
      record(cfg, job, dryRun, f.path, { bytes });
    } catch (error) {
      record(cfg, job, dryRun, f.path, { reason: String(error) });
    }
  }
}
