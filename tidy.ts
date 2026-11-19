import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";
import { loadConfig, type Config } from "./config";
import { appendLine, files, type Job } from "./lib";

export type Folder = { path: string; identity: string };

export function workFolder(cfg: Config, path: string): Folder | undefined {
  if (!cfg.workRoots.some(root => path.startsWith(root + sep)) || cfg.workRoots.includes(path)) return;
  try {
    const s = lstatSync(path, { bigint: true });
    if (s.isDirectory() && realpathSync(path) === path) return { path, identity: `${s.dev}:${s.ino}:${s.birthtimeNs}` };
  } catch { /* missing or inaccessible */ }
}
export function tidyJob(cfg: Config, job: Job, dryRun = false) {
  const folder = job.cwd;
  if (!folder || workFolder(cfg, folder.path)?.identity !== folder.identity) return;
  function record(path: string, reason?: string) {
    if (dryRun) console.log(reason ? "Would skip" : "Would remove", path, reason ?? "");
    else appendLine(files(cfg).ledger, { event: reason ? "tidy-skipped" : "removed", at: new Date().toISOString(),
      job: job.id, ticket: job.ticket, path, reason });
  }
  try {
    const run = Bun.spawnSync(["python3", "-I", join(import.meta.dir, "tidy-folders.py"), folder.path, folder.identity,
      JSON.stringify(cfg.disposableFolders), dryRun ? "preview" : "remove"], { cwd: folder.path });
    for (const line of run.stdout.toString().trim().split("\n").filter(Boolean)) {
      const { path, reason } = JSON.parse(line);
      record(path, reason);
    }
    if (run.exitCode !== 0) record(folder.path, run.stderr.toString().trim() || "cleanup failed");
  } catch (error) { record(folder.path, String(error)); }
}

function git(cwd: string, ...args: string[]) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  const r = Bun.spawnSync(["git", "--no-optional-locks", "--no-replace-objects", ...args], {
    cwd, env: { ...env, GIT_TERMINAL_PROMPT: "0" }, timeout: 30000,
  });
  if (r.exitCode !== 0) throw Error(r.stderr.toString().trim() || "Git inspection failed");
  return r.stdout.toString();
}
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";

export function listWorktrees(cfg: Config) {
  const seen = new Set<string>();
  function inspect(cwd: string) {
    for (const entry of git(cwd, "worktree", "list", "--porcelain", "-z").split("\0\0")) {
      const [first, ...fields] = entry.split("\0");
      if (!first?.startsWith("worktree ")) continue;
      const path = first.slice(9);
      if (seen.has(path) || !cfg.workRoots.some(root => path === root || path.startsWith(root + sep))) continue;
      seen.add(path);
      try {
        const blocked = fields.find(f => /^(bare|locked|prunable)( |$)/.test(f));
        if (blocked) throw Error(blocked);
        if (!lstatSync(join(path, ".git")).isFile()) throw Error("main checkout");
        if (git(path, "status", "--porcelain", "--ignored", "--untracked-files=all", "--ignore-submodules=none")) throw Error("local changes or files");
        if (git(path, "for-each-ref", "--format=%(objectname)", "refs/stash")) throw Error("repository has a stash");
        if (/(?:^|\0)[a-zS] /.test(git(path, "ls-files", "-v", "-z"))) throw Error("Git index hides local changes");
        const head = git(path, "rev-parse", "HEAD").trim();
        const pushed = git(path, "remote").trim().split("\n").filter(Boolean).some(remote =>
          git(path, "ls-remote", "--heads", remote).trim().split("\n").some(line => {
            const tip = line.split("\t")[0];
            return tip && git(path, "rev-list", "-1", head, "--not", tip) === "";
          }));
        if (!pushed) throw Error("HEAD could not be confirmed on a remote branch");
        console.log(`Looks removable: ${path}\n# Run from ${quote(cwd)}\ngit worktree remove ${quote(path)}`);
      } catch (error) { console.log(`Keep ${path}: ${String(error)}`); }
    }
  }
  function visit(path: string) {
    try {
      const entries = readdirSync(path, { withFileTypes: true });
      if (entries.some(e => e.name === "HEAD") && entries.some(e => e.name === "objects")) {
        inspect(path);
        return;
      }
      if (entries.some(e => e.name === ".git")) inspect(path);
      for (const e of entries) if (e.isDirectory() && e.name !== ".git") visit(join(path, e.name));
    } catch (error) { console.log(`Could not inspect ${path}: ${String(error)}`); }
  }
  for (const root of cfg.workRoots) {
    try {
      if (realpathSync(root) !== root) throw Error("root contains a link");
      visit(root);
    } catch (error) { console.log(`Could not inspect ${root}: ${String(error)}`); }
  }
}
if (import.meta.main) listWorktrees(loadConfig());
