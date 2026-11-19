"""Walk from open directory handles so a symlink swap cannot redirect cleanup."""
import json
import os
import stat
import sys

path, identity, names, mode = sys.argv[1:]
names = set(json.loads(names))
flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW


def walk(fd, path, removing=False, check_only=False):
    size = os.fstat(fd).st_blocks * 512
    entries = os.listdir(fd)
    if removing and ".git" in entries:
        raise ValueError("Git work inside disposable folder: " + path)
    for name in entries:
        info = os.stat(name, dir_fd=fd, follow_symlinks=False)
        if stat.S_ISDIR(info.st_mode):
            if not removing and name == ".git":
                continue
            if info.st_dev != device:
                if removing:
                    raise ValueError("mount inside disposable folder")
                continue
            selected = removing or name in names
            child = os.open(name, flags, dir_fd=fd)
            try:
                child_path = os.path.join(path, name)
                if selected and not removing and mode == "remove":
                    # Refuse the entire cache if it contains a nested checkout or mount.
                    walk(child, child_path, True, check_only=True)
                size_child = walk(child, child_path, selected, check_only)
                if selected and mode == "remove" and not check_only:
                    os.rmdir(name, dir_fd=fd)
            finally:
                os.close(child)
            if selected and not removing:
                print(json.dumps(dict(path=os.path.join(path, name), bytes=size_child)), flush=True)
            size += size_child
        elif removing:
            if info.st_nlink == 1:
                size += info.st_blocks * 512
            if mode == "remove" and not check_only:
                os.unlink(name, dir_fd=fd)
    return size


fd = os.open("/", flags)
try:
    for component in path.strip("/").split("/"):
        next_fd = os.open(component, flags, dir_fd=fd)
        os.close(fd)
        fd = next_fd
    info = os.fstat(fd)
    device = info.st_dev
    if identity.split(":")[:2] != [str(device), str(info.st_ino)]:
        raise ValueError("work folder was replaced")
    walk(fd, path)
finally:
    os.close(fd)
