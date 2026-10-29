//go:build linux || darwin

package main

import (
	"errors"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/sys/unix"
)

func ensureDesktopPrivateRoot(rootPath string) (bool, error) {
	if rootPath == "" || !filepath.IsAbs(rootPath) || strings.ContainsRune(rootPath, 0) || len(rootPath) > 16*1024 {
		return false, userError("invalid-root", "Desktop private filesystem root is invalid")
	}
	cleaned := filepath.Clean(rootPath)
	if cleaned == "/" {
		return false, userError("invalid-root", "Desktop private filesystem root cannot be the volume root")
	}
	anchor := cleaned
	missing := make([]string, 0, 4)
	var current int
	var err error
	for {
		current, err = unix.Open(anchor, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
		if err == nil {
			break
		}
		if !errors.Is(err, unix.ENOENT) {
			return false, err
		}
		name := filepath.Base(anchor)
		if name == "" || name == "." || name == ".." || len(name) > 255 {
			return false, userError("invalid-root", "Desktop private filesystem root contains an invalid component")
		}
		missing = append([]string{name}, missing...)
		next := filepath.Dir(anchor)
		if next == anchor {
			return false, userError("invalid-root", "Desktop private filesystem root has no existing ancestor")
		}
		anchor = next
	}
	defer func() { _ = unix.Close(current) }()
	created := false
	for _, name := range missing {
		made := false
		if mkdirErr := unix.Mkdirat(current, name, 0700); mkdirErr == nil {
			made = true
		} else if !errors.Is(mkdirErr, unix.EEXIST) {
			return false, mkdirErr
		}
		next, openErr := unix.Openat(current, name, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
		if openErr != nil {
			return false, openErr
		}
		var permissionErr error
		if made {
			permissionErr = secureDesktopPrivateNode(nodeHandle(next), true)
		} else {
			permissionErr = assertDesktopPrivateNode(nodeHandle(next), true)
		}
		if permissionErr != nil {
			unix.Close(next)
			return false, permissionErr
		}
		unix.Close(current)
		current = next
		created = created || made
	}
	var permissionErr error
	if created {
		permissionErr = secureDesktopPrivateNode(nodeHandle(current), true)
	} else {
		permissionErr = assertDesktopPrivateNode(nodeHandle(current), true)
	}
	if permissionErr != nil {
		return false, permissionErr
	}
	return created, nil
}

func openDesktopPrivateRoot(rootPath string) (*workspaceRoot, error) {
	if rootPath == "" || !filepath.IsAbs(rootPath) || strings.ContainsRune(rootPath, 0) || len(rootPath) > 16*1024 {
		return nil, userError("invalid-root", "Desktop private filesystem root is invalid")
	}
	cleaned := filepath.Clean(rootPath)
	parentFD, err := unix.Open(filepath.Dir(cleaned), unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	defer unix.Close(parentFD)
	current, err := unix.Openat(parentFD, filepath.Base(cleaned), unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	var stat unix.Stat_t
	if err := unix.Fstat(current, &stat); err != nil {
		unix.Close(current)
		return nil, err
	}
	if err := assertDesktopPrivateNode(nodeHandle(current), true); err != nil {
		unix.Close(current)
		return nil, err
	}
	return &workspaceRoot{containment: platformContainment, device: uint64(stat.Dev), fd: current}, nil
}

func (root *workspaceRoot) duplicateDesktopRootHandle() (nodeHandle, error) {
	fd, err := unix.Dup(root.fd)
	return nodeHandle(fd), err
}

func (root *workspaceRoot) openDesktopDirectoryAt(parent nodeHandle, name string) (nodeHandle, error) {
	return root.openDirectoryAt(parent, name)
}

func (root *workspaceRoot) createDesktopDirectoryAt(parent nodeHandle, name string) (nodeHandle, error) {
	handle, _, err := root.createDirectoryAt(parent, name)
	return handle, err
}

func (root *workspaceRoot) openDesktopNodeAt(parent nodeHandle, name string, directory bool) (nodeHandle, nodeStat, error) {
	if directory {
		handle, err := root.openDirectoryAt(parent, name)
		if err != nil {
			return -1, nodeStat{}, err
		}
		stat, err := statNodeHandle(handle)
		if err != nil {
			closeNode(handle)
			return -1, nodeStat{}, err
		}
		return handle, stat, nil
	}
	return root.openNodeAt(parent, name)
}

func (root *workspaceRoot) openDesktopNode(parts []string, directory bool) (nodeHandle, nodeStat, error) {
	if len(parts) == 0 {
		handle, err := root.duplicateDesktopRootHandle()
		if err != nil {
			return -1, nodeStat{}, err
		}
		stat, err := statNodeHandle(handle)
		if err != nil {
			closeNode(handle)
			return -1, nodeStat{}, err
		}
		return handle, stat, nil
	}
	parent, name, err := root.openDesktopParent(parts, false)
	if err != nil {
		return -1, nodeStat{}, err
	}
	defer closeNode(parent)
	return root.openDesktopNodeAt(parent, name, directory)
}

func (root *workspaceRoot) openDesktopParent(parts []string, create bool) (nodeHandle, string, error) {
	return root.openParent(parts, create)
}

func secureDesktopPrivateNode(handle nodeHandle, directory bool) error {
	var stat unix.Stat_t
	if err := unix.Fstat(int(handle), &stat); err != nil {
		return err
	}
	if int(stat.Uid) != os.Geteuid() {
		return userError("unsafe-permissions", "Desktop private path is not owned by the current user")
	}
	mode := uint32(0600)
	if directory {
		mode = 0700
	}
	if err := unix.Fchmod(int(handle), mode); err != nil {
		return err
	}
	return assertDesktopPrivateNode(handle, directory)
}

func assertDesktopPrivateNode(handle nodeHandle, directory bool) error {
	var stat unix.Stat_t
	if err := unix.Fstat(int(handle), &stat); err != nil {
		return err
	}
	expectedType := uint32(unix.S_IFREG)
	expectedMode := uint32(0600)
	if directory {
		expectedType = unix.S_IFDIR
		expectedMode = 0700
	}
	if uint32(stat.Mode)&unix.S_IFMT != expectedType || uint32(stat.Mode)&0777 != expectedMode || int(stat.Uid) != os.Geteuid() {
		return userError("unsafe-permissions", "Desktop private path does not have private owner-only permissions")
	}
	return nil
}

func removeDesktopPrivateFileAt(root *workspaceRoot, parent nodeHandle, name string) (bool, error) {
	handle, stat, err := root.openDesktopNodeAt(parent, name, false)
	if err != nil {
		return false, err
	}
	defer closeNode(handle)
	if stat.kind != "file" {
		return false, userError("not-regular", "Desktop private path must name a regular file")
	}
	if err := assertDesktopPrivateNode(handle, false); err != nil {
		return false, err
	}
	current, err := root.statNodeAt(parent, name)
	if err != nil {
		return false, err
	}
	if current.identity != stat.identity {
		return false, userError("concurrent-modification", "Desktop private file changed while it was being removed")
	}
	if err := unix.Unlinkat(int(parent), name, 0); err != nil {
		return false, err
	}
	after, err := statNodeHandle(handle)
	if err != nil {
		return true, nil
	}
	if after.identity != stat.identity {
		return true, nil
	}
	if err := fsyncDirectory(int(parent)); err != nil {
		// The unlink is already committed. It is not safe to claim it failed and
		// invite a retry against a newly-created file of the same name.
		return true, nil
	}
	return true, nil
}

func isDesktopNotFound(err error) bool { return errors.Is(err, unix.ENOENT) }
