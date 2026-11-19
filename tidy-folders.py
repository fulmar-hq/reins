"""Inspect each listed cache before removing anything, using its path for every operation."""
import json
import os
from pathlib import Path
import stat
import subprocess
import sys

path, identity, names, mode = sys.argv[1:]
root = Path(path)
names = set(json.loads(names))
info = root.lstat()
if identity.split(":")[:2] != [str(info.st_dev), str(info.st_ino)]:
    raise ValueError("work folder was replaced")


def check(path):
    # Resolve the current name, including its parents. Never follow a moved directory handle.
    if (not os.path.samestat(info, root.lstat()) or path.parent.resolve() != path.parent
            or not path.resolve().is_relative_to(root)):
        raise ValueError("path moved or points outside the work folder: " + str(path))


def git_metadata(path):
    # Bare repositories have no .git entry. Linked worktree metadata uses commondir.
    return path.name == ".git" or (os.path.lexists(path / "HEAD") and
            (os.path.lexists(path / "objects") or os.path.lexists(path / "commondir")))


def cache_entries(path):
    check(path)
    entry = path.lstat()
    if stat.S_ISDIR(entry.st_mode):
        if entry.st_dev != info.st_dev or git_metadata(path) or os.path.lexists(path / ".git"):
            raise ValueError("mount or Git work inside disposable folder")
        for child in path.iterdir():
            yield from cache_entries(child)
    yield path, entry


# Inspect the owning checkout's index even when the caller has a different Git context.
git_env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
git_env["LC_ALL"] = "C"


def has_tracked_files(path):
    result = subprocess.run(["git", "ls-files", "-z", "--", ":(literal,icase)" + str(path)],
                            cwd=path.parent, capture_output=True, env=git_env)
    if result.returncode and b"not a git repository" in result.stderr and not any(
            os.path.lexists(p / ".git") for p in path.parents):
        return False
    result.check_returncode()
    return bool(result.stdout)


def tidy(path):
    entries = list(cache_entries(path))
    if has_tracked_files(path):
        raise ValueError("folder contains Git-tracked files")
    if mode == "remove":
        for child, entry in entries:
            if not os.path.samestat(entry, child.lstat()):
                raise ValueError("cache entry was replaced")
            check(child)
            if stat.S_ISDIR(entry.st_mode):
                child.rmdir()
            else:
                child.unlink()
    return {"bytes": sum(e.st_blocks * 512 for _, e in entries
                         if stat.S_ISDIR(e.st_mode) or e.st_nlink == 1)}


def walk(parent):
    for path in parent.iterdir():
        entry = path.lstat()
        if path.name == ".git" or not stat.S_ISDIR(entry.st_mode) or entry.st_dev != info.st_dev:
            continue
        check(path)
        if path.name in names:
            try:
                detail = tidy(path)
            except (OSError, ValueError, subprocess.SubprocessError) as error:
                detail = {"reason": str(error)}
            print(json.dumps(dict(path=str(path), **detail)), flush=True)
        elif not git_metadata(path) and not os.path.lexists(path / ".git"):
            walk(path)


if any(git_metadata(p) for p in (root, *root.parents)):
    raise ValueError("work folder is inside Git metadata")
walk(root)
