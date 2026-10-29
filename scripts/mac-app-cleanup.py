"""Remove only installer-owned copies after verified installation, under its lock."""
import fcntl
import json
import os
import plistlib
import re
import shutil
import stat
import sys


def cleanup(app, revision, held):
    result = {"removed": [], "unowned": [], "warnings": []}
    lock = None
    if held != "held":
        lock = os.open(app + ".install.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        if not stat.S_ISREG(os.fstat(lock).st_mode):
            raise ValueError("Application lock is not a regular file")
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            os.close(lock)
            result["warnings"].append("Application lock is busy; cleanup skipped")
            return result
    try:
        if not stat.S_ISDIR(os.lstat(app).st_mode):
            raise ValueError("Installed application is not a real directory")
        with open(os.path.join(app, "Contents", "Info.plist"), "rb") as stream:
            if plistlib.load(stream).get("OpensteerSourceRevision") != revision:
                raise ValueError("Installed SHA changed; cleanup skipped")
        parent, name = os.path.split(app)
        owned = re.compile(re.escape(name) + r"\.[a-f0-9]{40}\.(previous|next)")
        for entry in sorted(os.listdir(parent)):
            if not entry.startswith(name + ".") or entry == name + ".install.lock":
                continue
            candidate = os.path.join(parent, entry)
            try:
                info = os.lstat(candidate)
                if owned.fullmatch(entry) and stat.S_ISDIR(info.st_mode):
                    # rmtree refuses a symlink substituted for this directory.
                    shutil.rmtree(candidate)
                    result["removed"].append(candidate)
                else:
                    size = info.st_size
                    if stat.S_ISDIR(info.st_mode):
                        for directory, dirs, files in os.walk(candidate, followlinks=False):
                            size += sum(os.lstat(os.path.join(directory, child)).st_size
                                        for child in dirs + files)
                    result["unowned"].append({"path": candidate, "bytes": size})
            except Exception as error:
                result["warnings"].append(str(error) + ": " + candidate)
    finally:
        if lock is not None:
            os.close(lock)
    return result


print(json.dumps(cleanup(sys.argv[2], sys.argv[3], sys.argv[4])))
