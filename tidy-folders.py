"""The caller starts us inside the recorded work folder. Relative operations stay anchored there."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

folder, identity, names, mode = sys.argv[1:]
info = os.stat(".")
if os.getcwd() != folder or identity.split(":")[:2] != [str(info.st_dev), str(info.st_ino)]:
    sys.exit("work folder changed")

git_env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
worktree = subprocess.run(["git", "rev-parse", "--is-inside-work-tree"], capture_output=True, env=git_env)
if worktree.returncode or worktree.stdout.strip() != b"true":
    sys.exit("work folder is not in a Git worktree")

for name in json.loads(names):
    target = Path(name)
    path = Path(folder) / name
    try:
        if not os.path.lexists(target):
            continue
        if target.is_symlink() or not target.is_dir() or target.resolve() != path:
            raise ValueError("not a direct, real directory")
        tracked = subprocess.run(["git", "ls-files", "-z", "--", ":(literal,icase)" + name],
                                 capture_output=True, env=git_env, check=True)
        if tracked.stdout:
            raise ValueError("folder contains Git-tracked files")
        if mode == "remove":
            shutil.rmtree(target)
        print(json.dumps({"path": str(path)}))
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        print(json.dumps({"path": str(path), "reason": str(error)}))
