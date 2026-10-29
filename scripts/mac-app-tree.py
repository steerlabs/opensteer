"""Canonical Mac app inventory and ACL preservation without following symlinks.

Node has no ACL/xattr API; one bounded stdlib helper avoids a process per entry.
"""
import ctypes
import errno
import hashlib
import json
import os
import stat
import sys

libc = ctypes.CDLL("/usr/lib/libSystem.B.dylib", use_errno=True)
libc.acl_get_link_np.argtypes = [ctypes.c_char_p, ctypes.c_int]
libc.acl_get_link_np.restype = ctypes.c_void_p
libc.acl_to_text.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_ssize_t)]
libc.acl_to_text.restype = ctypes.c_void_p
libc.acl_free.argtypes = [ctypes.c_void_p]
libc.acl_free.restype = ctypes.c_int
libc.acl_set_link_np.argtypes = [ctypes.c_char_p, ctypes.c_int, ctypes.c_void_p]
libc.acl_set_link_np.restype = ctypes.c_int
libc.acl_init.argtypes = [ctypes.c_int]
libc.acl_init.restype = ctypes.c_void_p
libc.listxattr.argtypes = [ctypes.c_char_p, ctypes.c_void_p, ctypes.c_size_t, ctypes.c_int]
libc.listxattr.restype = ctypes.c_ssize_t
libc.getxattr.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_void_p, ctypes.c_size_t, ctypes.c_uint32, ctypes.c_int]
libc.getxattr.restype = ctypes.c_ssize_t


def xattrs(filename):
    encoded = os.fsencode(filename)
    size = libc.listxattr(encoded, None, 0, 1)  # XATTR_NOFOLLOW
    if size < 0:
        raise OSError(ctypes.get_errno(), "Cannot list app xattrs", filename)
    names = ctypes.create_string_buffer(size)
    if libc.listxattr(encoded, names, size, 1) != size:
        raise ValueError("App xattrs changed during inventory")
    result = {}
    for name in sorted(filter(None, names.raw.split(b"\0"))):
        length = libc.getxattr(encoded, name, None, 0, 0, 1)
        if length < 0:
            raise OSError(ctypes.get_errno(), "Cannot size app xattr", filename)
        value = ctypes.create_string_buffer(length)
        if libc.getxattr(encoded, name, value, length, 0, 1) != length:
            raise ValueError("App xattr changed during inventory")
        result[name.decode("utf-8")] = hashlib.sha256(value.raw).hexdigest()
    return result


def acl_text(filename):
    ctypes.set_errno(0)
    acl = libc.acl_get_link_np(os.fsencode(filename), 0x100)  # ACL_TYPE_EXTENDED
    if not acl:
        error = ctypes.get_errno()
        if error in (0, errno.ENOENT):
            return ""
        raise OSError(error, "Cannot read app ACL", filename)
    text = None
    try:
        text = libc.acl_to_text(acl, None)
        if not text:
            raise OSError(ctypes.get_errno(), "Cannot encode app ACL", filename)
        return ctypes.string_at(text).decode("utf-8")
    finally:
        if text:
            libc.acl_free(text)
        libc.acl_free(acl)


def inventory(root):
    entries = []
    contained_root = os.path.realpath(root, strict=True)

    def walk(relative):
        filename = root if relative == "." else os.path.join(root, relative)
        before = os.lstat(filename)
        entry = {"path": relative, "mode": stat.S_IMODE(before.st_mode),
                 "uid": before.st_uid, "gid": before.st_gid,
                 "flags": before.st_flags, "acl": acl_text(filename),
                 "xattrs": xattrs(filename)}
        if stat.S_ISLNK(before.st_mode):
            resolved = os.path.realpath(filename, strict=True)
            if os.path.commonpath([contained_root, resolved]) != contained_root:
                raise ValueError("App symlink escapes bundle: " + relative)
            entry.update(kind="symlink", target=os.readlink(filename))
        elif stat.S_ISREG(before.st_mode):
            if before.st_nlink != 1:
                raise ValueError("App regular file must have one link: " + relative)
            digest = hashlib.sha256()
            with open(filename, "rb") as file:
                while block := file.read(1024 * 1024):
                    digest.update(block)
            entry.update(kind="file", sha256=digest.hexdigest())
        elif stat.S_ISDIR(before.st_mode):
            entry.update(kind="directory")
        else:
            raise ValueError("Unsupported app tree entry: " + relative)
        entries.append(entry)
        if entry["kind"] == "directory":
            children = sorted(os.listdir(filename))
            for name in children:
                walk(name if relative == "." else relative + "/" + name)
            if sorted(os.listdir(filename)) != children:
                raise ValueError("App directory children changed during inventory: " + relative)
        # Directories must be checked after their descendants, too: a late
        # insertion during a child's hash must not escape the inventory.
        after = os.lstat(filename)
        if (before.st_dev, before.st_ino, before.st_mode, before.st_nlink,
                before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (
                after.st_dev, after.st_ino, after.st_mode, after.st_nlink,
                after.st_size, after.st_mtime_ns, after.st_ctime_ns):
            raise ValueError("App tree changed during inventory: " + relative)

    if not stat.S_ISDIR(os.lstat(root).st_mode):
        raise ValueError("App tree root must be a real directory")
    walk(".")
    return entries


def copy_acls(source, destination):
    # Darwin's cp -c can omit ACLs despite -p. Restore only ACL metadata;
    # file data remains cloned, and the full inventory verifies every field.
    def walk(relative):
        src = os.path.join(source, relative)
        dst = os.path.join(destination, relative)
        source_stat = os.lstat(src)
        if stat.S_IFMT(source_stat.st_mode) != stat.S_IFMT(os.lstat(dst).st_mode):
            raise ValueError("App entry changed during ACL copy")
        if acl_text(src) != acl_text(dst):
            ctypes.set_errno(0)
            acl = libc.acl_get_link_np(os.fsencode(src), 0x100)
            if not acl:
                error = ctypes.get_errno()
                if error not in (0, errno.ENOENT):
                    raise OSError(error, "Cannot read source ACL", src)
                acl = libc.acl_init(0)
            if not acl:
                raise OSError(ctypes.get_errno(), "Cannot initialize ACL", src)
            try:
                if libc.acl_set_link_np(os.fsencode(dst), 0x100, acl) != 0:
                    raise OSError(ctypes.get_errno(), "Cannot preserve cloned app ACL", dst)
            finally:
                libc.acl_free(acl)
        if stat.S_ISDIR(source_stat.st_mode):
            for name in sorted(os.listdir(src)):
                walk(os.path.join(relative, name))

    if not stat.S_ISDIR(os.lstat(source).st_mode):
        raise ValueError("App source must be a real directory")
    walk(".")


if __name__ == "__main__":
    if sys.argv[1] == "--copy-acls":
        copy_acls(sys.argv[2], sys.argv[3])
    else:
        json.dump(inventory(sys.argv[1]), sys.stdout, ensure_ascii=True, separators=(",", ":"))
