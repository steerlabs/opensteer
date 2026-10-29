//go:build linux || darwin

package main

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/sys/unix"
)

type nodeHandle = int

type workspaceRoot struct {
	containment string
	device      uint64
	fd          int
}

var fsyncDirectory = unix.Fsync

func openWorkspaceRoot(path string, requireMountBoundary bool) (*workspaceRoot, error) {
	if path == "" || !filepath.IsAbs(path) || strings.ContainsRune(path, 0) || len(path) > 16*1024 {
		return nil, userError("invalid-root", "Native filesystem Workspace root is invalid")
	}
	fd, err := unix.Open(path, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	var stat unix.Stat_t
	if err := unix.Fstat(fd, &stat); err != nil {
		unix.Close(fd)
		return nil, err
	}
	if requireMountBoundary {
		parentPath := filepath.Dir(filepath.Clean(path))
		parentFD, openErr := unix.Open(parentPath, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
		if openErr != nil {
			unix.Close(fd)
			return nil, openErr
		}
		var parentStat unix.Stat_t
		statErr := unix.Fstat(parentFD, &parentStat)
		unix.Close(parentFD)
		if statErr != nil {
			unix.Close(fd)
			return nil, statErr
		}
		if uint64(parentStat.Dev) == uint64(stat.Dev) {
			unix.Close(fd)
			return nil, userError("root-not-mount", "Native filesystem Workspace root is not an isolated mount boundary")
		}
	}
	return &workspaceRoot{containment: platformContainment, device: uint64(stat.Dev), fd: fd}, nil
}

func ensureWorkspaceRoot(rootPath string) (ensureRootResult, error) {
	if rootPath == "" || !filepath.IsAbs(rootPath) || strings.ContainsRune(rootPath, 0) || len(rootPath) > 16*1024 {
		return ensureRootResult{}, userError("invalid-root", "Native filesystem Workspace root is invalid")
	}
	cleaned := filepath.Clean(rootPath)
	current, err := unix.Open("/", unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return ensureRootResult{}, err
	}
	created := false
	if cleaned != "/" {
		components := strings.Split(strings.TrimPrefix(cleaned, "/"), "/")
		for index, component := range components {
			if component == "" || component == "." || component == ".." || len(component) > 255 {
				unix.Close(current)
				return ensureRootResult{}, userError("invalid-root", "Native filesystem Workspace root contains an invalid component")
			}
			next, openErr := unix.Openat(current, component, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
			if errors.Is(openErr, unix.ENOENT) {
				mkdirErr := unix.Mkdirat(current, component, 0700)
				if mkdirErr == nil {
					created = index == len(components)-1
				} else if !errors.Is(mkdirErr, unix.EEXIST) {
					unix.Close(current)
					return ensureRootResult{}, mkdirErr
				}
				next, openErr = unix.Openat(current, component, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
			}
			if openErr != nil {
				unix.Close(current)
				return ensureRootResult{}, openErr
			}
			unix.Close(current)
			current = next
		}
	}
	defer unix.Close(current)
	var stat unix.Stat_t
	if err := unix.Fstat(current, &stat); err != nil {
		return ensureRootResult{}, err
	}
	return ensureRootResult{Created: created, Identity: directoryIdentityFromStat(nodeStatFromUnix(stat))}, nil
}

func (root *workspaceRoot) close() { _ = unix.Close(root.fd) }

func closeNode(handle nodeHandle) { _ = unix.Close(int(handle)) }

func statNodeHandle(handle nodeHandle) (nodeStat, error) {
	var stat unix.Stat_t
	if err := unix.Fstat(int(handle), &stat); err != nil {
		return nodeStat{}, err
	}
	return nodeStatFromUnix(stat), nil
}

func duplicateNodeFile(handle nodeHandle, name string) (*os.File, error) {
	duplicate, err := unix.Dup(int(handle))
	if err != nil {
		return nil, err
	}
	return os.NewFile(uintptr(duplicate), name), nil
}

func statOpenFile(file *os.File) (nodeStat, error) {
	var stat unix.Stat_t
	if err := unix.Fstat(int(file.Fd()), &stat); err != nil {
		return nodeStat{}, err
	}
	return nodeStatFromUnix(stat), nil
}

func directoryIdentityFromStat(stat nodeStat) directoryIdentityResult {
	return directoryIdentityResult{
		FileID: stat.identity.fileID, Kind: "posix", VolumeID: stat.identity.volumeID,
	}
}

func (root *workspaceRoot) probe() error {
	fd, err := root.openDirectoryAt(nodeHandle(root.fd), ".")
	if err == nil {
		closeNode(fd)
	}
	return err
}

func relativeParts(value string, allowRoot bool) ([]string, string, error) {
	if value == "." && allowRoot {
		return nil, ".", nil
	}
	if value == "" || strings.HasPrefix(value, "/") || strings.ContainsRune(value, 0) || len(value) > 4096 {
		return nil, "", userError("invalid-path", "Path must be relative to the workspace")
	}
	parts := strings.Split(value, "/")
	for _, part := range parts {
		if part == "" || part == "." || part == ".." {
			return nil, "", userError("outside-workspace", "Path escapes the workspace")
		}
		if len(part) > 255 {
			return nil, "", userError("invalid-path", "Workspace path component is too long")
		}
	}
	return parts, strings.Join(parts, "/"), nil
}

func (root *workspaceRoot) openNode(parts []string) (nodeHandle, nodeStat, error) {
	if len(parts) == 0 {
		fd, err := unix.Dup(root.fd)
		if err != nil {
			return -1, nodeStat{}, err
		}
		var stat unix.Stat_t
		if err := unix.Fstat(fd, &stat); err != nil {
			unix.Close(fd)
			return -1, nodeStat{}, err
		}
		if err := root.assertSameDevice(stat); err != nil {
			unix.Close(fd)
			return -1, nodeStat{}, err
		}
		return nodeHandle(fd), nodeStatFromUnix(stat), nil
	}
	parentFD, name, err := root.openParent(parts, false)
	if err != nil {
		return -1, nodeStat{}, err
	}
	defer closeNode(parentFD)
	return root.openNodeAt(parentFD, name)
}

func (root *workspaceRoot) openNodeAt(parentFD nodeHandle, name string) (nodeHandle, nodeStat, error) {
	fd, err := strictOpenAt(int(parentFD), name, unix.O_RDONLY|unix.O_NONBLOCK|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return -1, nodeStat{}, err
	}
	var stat unix.Stat_t
	if err := unix.Fstat(fd, &stat); err != nil {
		unix.Close(fd)
		return -1, nodeStat{}, err
	}
	if err := root.assertSameDevice(stat); err != nil {
		unix.Close(fd)
		return -1, nodeStat{}, err
	}
	return nodeHandle(fd), nodeStatFromUnix(stat), nil
}

func (root *workspaceRoot) openDirectoryAt(parentFD nodeHandle, name string) (nodeHandle, error) {
	fd, err := strictOpenAt(int(parentFD), name, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return -1, err
	}
	var stat unix.Stat_t
	if err := unix.Fstat(fd, &stat); err != nil {
		unix.Close(fd)
		return -1, err
	}
	if err := root.assertSameDevice(stat); err != nil {
		unix.Close(fd)
		return -1, err
	}
	return nodeHandle(fd), nil
}

func (root *workspaceRoot) createDirectoryAt(parentFD nodeHandle, name string) (nodeHandle, nodeStat, error) {
	if err := unix.Mkdirat(int(parentFD), name, 0700); err != nil {
		return -1, nodeStat{}, err
	}
	handle, err := root.openDirectoryAt(parentFD, name)
	if err != nil {
		return -1, nodeStat{}, err
	}
	var stat unix.Stat_t
	if err := unix.Fstat(handle, &stat); err != nil {
		closeNode(handle)
		return -1, nodeStat{}, err
	}
	return handle, nodeStatFromUnix(stat), nil
}

func isAlreadyExists(err error) bool { return errors.Is(err, unix.EEXIST) }

func (root *workspaceRoot) statNodeAt(parentFD nodeHandle, name string) (nodeStat, error) {
	var stat unix.Stat_t
	if err := unix.Fstatat(int(parentFD), name, &stat, unix.AT_SYMLINK_NOFOLLOW); err != nil {
		return nodeStat{}, err
	}
	if err := root.assertSameDevice(stat); err != nil {
		return nodeStat{}, err
	}
	return nodeStatFromUnix(stat), nil
}

func (root *workspaceRoot) assertSameDevice(stat unix.Stat_t) error {
	if uint64(stat.Dev) != root.device {
		return userError("cross-device", "Nested filesystem mounts are unavailable to Native tools")
	}
	return nil
}

func (root *workspaceRoot) openParent(parts []string, create bool) (nodeHandle, string, error) {
	if len(parts) == 0 {
		return -1, "", userError("invalid-path", "Path must name a file inside the Workspace")
	}
	duplicated, err := unix.Dup(root.fd)
	if err != nil {
		return -1, "", err
	}
	current := nodeHandle(duplicated)
	for _, part := range parts[:len(parts)-1] {
		next, openErr := root.openDirectoryAt(current, part)
		if openErr != nil && create && errors.Is(openErr, unix.ENOENT) {
			mkdirErr := unix.Mkdirat(int(current), part, 0700)
			if mkdirErr != nil && !errors.Is(mkdirErr, unix.EEXIST) {
				closeNode(current)
				return -1, "", mkdirErr
			}
			next, openErr = root.openDirectoryAt(current, part)
		}
		if openErr != nil {
			closeNode(current)
			return -1, "", openErr
		}
		closeNode(current)
		current = next
	}
	return current, parts[len(parts)-1], nil
}

func (root *workspaceRoot) atomicWrite(parentFD nodeHandle, name string, content []byte, expected *fileIdentity) (string, error) {
	var target unix.Stat_t
	if err := unix.Fstatat(int(parentFD), name, &target, unix.AT_SYMLINK_NOFOLLOW); err == nil {
		if fileType(uint32(target.Mode)) != "file" {
			return "", userError("not-regular", "Workspace write target must be a regular file or a new path")
		}
		if expected != nil && fileIdentityFromStat(target) != *expected {
			return "", userError("concurrent-modification", "Workspace file changed while replace_text was running")
		}
	} else if !errors.Is(err, unix.ENOENT) {
		return "", err
	} else if expected != nil {
		return "", userError("concurrent-modification", "Workspace file changed while replace_text was running")
	}

	random := make([]byte, 16)
	if _, err := rand.Read(random); err != nil {
		return "", err
	}
	temporary := ".opensteer-write-" + hex.EncodeToString(random)
	fd, err := strictOpenAt(int(parentFD), temporary, unix.O_WRONLY|unix.O_CREAT|unix.O_EXCL|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0600)
	if err != nil {
		return "", err
	}
	cleanup := true
	defer func() {
		_ = unix.Close(fd)
		if cleanup {
			_ = unix.Unlinkat(int(parentFD), temporary, 0)
		}
	}()

	written := 0
	for written < len(content) {
		count, writeErr := unix.Write(fd, content[written:])
		if writeErr != nil {
			return "", writeErr
		}
		if count == 0 {
			return "", unix.EIO
		}
		written += count
	}
	if err := unix.Fsync(fd); err != nil {
		return "", err
	}
	if err := unix.Close(fd); err != nil {
		return "", err
	}
	fd = -1

	if err := unix.Fstatat(int(parentFD), name, &target, unix.AT_SYMLINK_NOFOLLOW); err == nil {
		if fileType(uint32(target.Mode)) != "file" {
			return "", userError("not-regular", "Workspace write target must be a regular file or a new path")
		}
		if expected != nil && fileIdentityFromStat(target) != *expected {
			return "", userError("concurrent-modification", "Workspace file changed while replace_text was running")
		}
	} else if !errors.Is(err, unix.ENOENT) {
		return "", err
	} else if expected != nil {
		return "", userError("concurrent-modification", "Workspace file changed while replace_text was running")
	}
	if err := unix.Renameat(int(parentFD), temporary, int(parentFD), name); err != nil {
		return "", err
	}
	cleanup = false
	// The rename is already committed at this point. Returning an error after a
	// failed directory fsync would make replace_text look safely retryable even
	// though its first mutation took effect. Report a successful atomic commit
	// with an explicit durability warning instead.
	if err := fsyncDirectory(int(parentFD)); err != nil {
		return "sync-uncertain", nil
	}
	return "synced", nil
}

func fileIdentityFromStat(stat unix.Stat_t) fileIdentity {
	return fileIdentity{
		fileID: fmt.Sprintf("%d", uint64(stat.Ino)), volumeID: persistentVolumeID(uint64(stat.Dev)),
	}
}

func nodeStatFromUnix(stat unix.Stat_t) nodeStat {
	return nodeStat{
		changedUnixNano:  statChangedUnixNano(stat),
		identity:         fileIdentityFromStat(stat),
		kind:             fileType(uint32(stat.Mode)),
		mode:             uint32(stat.Mode),
		modifiedUnixNano: statModifiedUnixNano(stat),
		size:             stat.Size,
	}
}

func nativeFilesComponent(value []byte) (string, error) {
	if len(value) == 0 || len(value) > 255 || string(value) == "." || string(value) == ".." {
		return "", userError("invalid-path", "Files key contains an invalid path component")
	}
	for _, octet := range value {
		if octet == 0 || octet == '/' {
			return "", userError("invalid-path", "Files key contains an invalid path component")
		}
	}
	return string(value), nil
}

func fileType(mode uint32) string {
	switch mode & unix.S_IFMT {
	case unix.S_IFREG:
		return "file"
	case unix.S_IFDIR:
		return "directory"
	case unix.S_IFLNK:
		return "symlink"
	default:
		return "other"
	}
}

func lockDirectory(fd nodeHandle) error { return unix.Flock(int(fd), unix.LOCK_EX) }

func unlockDirectory(fd nodeHandle) { _ = unix.Flock(int(fd), unix.LOCK_UN) }

func platformPublicError(err error) (string, string, bool) {
	switch {
	case errors.Is(err, unix.ENOENT):
		return "not-found", "Workspace path does not exist", true
	case errors.Is(err, unix.ELOOP):
		return "symlink-denied", "Workspace paths containing symlinks are not available to Native tools", true
	case errors.Is(err, unix.ENOTDIR):
		return "unsafe-parent", "Workspace path contains a symlink or non-directory parent; paths containing symlinks are unavailable", true
	case errors.Is(err, unix.EXDEV):
		return "cross-device", "Nested filesystem mounts are unavailable to Native tools", true
	case errors.Is(err, unix.EACCES), errors.Is(err, unix.EPERM):
		return "permission-denied", "Workspace path is not accessible", true
	case errors.Is(err, unix.ENOSYS), errors.Is(err, unix.EINVAL):
		return "helper-unavailable", "Native filesystem containment is unavailable on this system", true
	default:
		return "", "", false
	}
}
