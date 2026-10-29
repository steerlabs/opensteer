package main

import (
	"encoding/base64"
	"errors"
	"io"
	"runtime"
)

const maxDesktopPrivateFileBytes = 1 * 1024 * 1024

type desktopPrivateReadResult struct {
	ContentBase64 string `json:"contentBase64"`
	Size          int    `json:"size"`
}

type desktopPrivateMutationResult struct {
	Changed bool `json:"changed"`
}

type desktopPrivateRootResult struct {
	Created  bool                    `json:"created"`
	Identity directoryIdentityResult `json:"identity"`
}

type desktopPrivateDirectoryEmptyResult struct {
	Empty bool `json:"empty"`
}

// executeDesktopPrivate is a separate authority surface for the signed Desktop
// main process. Its root is an app-owned directory with a private OS ACL. Every
// descendant is reached relative to that verified directory handle; absolute
// path traversal, reparse points, and symlinks are never accepted.
func executeDesktopPrivate(input request) (any, error) {
	if input.Operation == "desktop-ensure-root" {
		if input.Path != "" {
			return nil, userError("invalid-request", "Desktop private root creation does not accept a relative path")
		}
		created, err := ensureDesktopPrivateRoot(input.Root)
		if err != nil {
			return nil, err
		}
		root, err := openDesktopPrivateRoot(input.Root)
		if err != nil {
			return nil, err
		}
		defer root.close()
		handle, stat, err := root.openDesktopNode(nil, true)
		if err != nil {
			return nil, err
		}
		if err := assertDesktopPrivateNode(handle, true); err != nil {
			closeNode(handle)
			return nil, err
		}
		closeNode(handle)
		return desktopPrivateRootResult{Created: created, Identity: directoryIdentityFromStat(stat)}, nil
	}
	root, err := openDesktopPrivateRoot(input.Root)
	if err != nil {
		return nil, err
	}
	defer root.close()
	if input.ExpectedRootIdentity == nil || !validExpectedRootIdentity(*input.ExpectedRootIdentity) {
		return nil, userError("invalid-request", "Desktop private operation requires its expected root identity")
	}
	rootHandle, rootStat, err := root.openDesktopNode(nil, true)
	if err != nil {
		return nil, err
	}
	if err := assertDesktopPrivateNode(rootHandle, true); err != nil {
		closeNode(rootHandle)
		return nil, err
	}
	closeNode(rootHandle)
	if directoryIdentityFromStat(rootStat) != *input.ExpectedRootIdentity {
		return nil, userError("root-replaced", "Desktop private root identity no longer matches this application process")
	}

	switch input.Operation {
	case "desktop-probe":
		if input.Path != "" {
			return nil, userError("invalid-request", "Desktop private probe does not accept a relative path")
		}
		return map[string]any{
			"binaryIdentity":  helperBinaryIdentity,
			"binaryVersion":   helperBinaryVersion,
			"containment":     root.containment,
			"platform":        runtime.GOOS,
		}, nil
	case "desktop-ensure-directory":
		return executeDesktopEnsureDirectory(root, input)
	case "desktop-read-file":
		return executeDesktopReadFile(root, input)
	case "desktop-create-file":
		return executeDesktopWriteFile(root, input, true)
	case "desktop-replace-file":
		return executeDesktopWriteFile(root, input, false)
	case "desktop-remove-file":
		return executeDesktopRemoveFile(root, input)
	case "desktop-file-exists":
		return executeDesktopFileExists(root, input)
	case "desktop-directory-empty":
		return executeDesktopDirectoryEmpty(root, input)
	default:
		return nil, userError("invalid-operation", "Desktop private filesystem operation is invalid")
	}
}

func executeDesktopFileExists(root *workspaceRoot, input request) (desktopPrivateMutationResult, error) {
	parts, _, err := relativeParts(input.Path, false)
	if err != nil {
		return desktopPrivateMutationResult{}, err
	}
	handle, stat, err := root.openDesktopNode(parts, false)
	if isDesktopNotFound(err) {
		return desktopPrivateMutationResult{Changed: false}, nil
	}
	if err != nil {
		return desktopPrivateMutationResult{}, err
	}
	defer closeNode(handle)
	if stat.kind != "file" {
		return desktopPrivateMutationResult{}, userError("not-regular", "Desktop private path must name a regular file")
	}
	if err := assertDesktopPrivateNode(handle, false); err != nil {
		return desktopPrivateMutationResult{}, err
	}
	return desktopPrivateMutationResult{Changed: true}, nil
}

func executeDesktopEnsureDirectory(root *workspaceRoot, input request) (desktopPrivateMutationResult, error) {
	parts, _, err := relativeParts(input.Path, true)
	if err != nil {
		return desktopPrivateMutationResult{}, err
	}
	if len(parts) == 0 {
		handle, err := root.duplicateDesktopRootHandle()
		if err != nil {
			return desktopPrivateMutationResult{}, err
		}
		defer closeNode(handle)
		if err := secureDesktopPrivateNode(handle, true); err != nil {
			return desktopPrivateMutationResult{}, err
		}
		return desktopPrivateMutationResult{Changed: false}, nil
	}
	current, err := root.duplicateDesktopRootHandle()
	if err != nil {
		return desktopPrivateMutationResult{}, err
	}
	defer func() { closeNode(current) }()
	changed := false
	for _, component := range parts {
		next, openErr := root.openDesktopDirectoryAt(current, component)
		created := false
		if isDesktopNotFound(openErr) {
			next, openErr = root.createDesktopDirectoryAt(current, component)
			if openErr == nil {
				changed = true
				created = true
			}
		}
		if openErr != nil {
			return desktopPrivateMutationResult{}, openErr
		}
		var permissionErr error
		if created {
			permissionErr = secureDesktopPrivateNode(next, true)
		} else {
			permissionErr = assertDesktopPrivateNode(next, true)
		}
		if permissionErr != nil {
			closeNode(next)
			return desktopPrivateMutationResult{}, permissionErr
		}
		closeNode(current)
		current = next
	}
	return desktopPrivateMutationResult{Changed: changed}, nil
}

func executeDesktopReadFile(root *workspaceRoot, input request) (desktopPrivateReadResult, error) {
	if input.MaxBytes < 1 || input.MaxBytes > maxDesktopPrivateFileBytes {
		return desktopPrivateReadResult{}, userError("invalid-request", "Desktop private file read bound is invalid")
	}
	parts, _, err := relativeParts(input.Path, false)
	if err != nil {
		return desktopPrivateReadResult{}, err
	}
	handle, stat, err := root.openDesktopNode(parts, false)
	if err != nil {
		return desktopPrivateReadResult{}, err
	}
	defer closeNode(handle)
	if stat.kind != "file" {
		return desktopPrivateReadResult{}, userError("not-regular", "Desktop private path must name a regular file")
	}
	if err := assertDesktopPrivateNode(handle, false); err != nil {
		return desktopPrivateReadResult{}, err
	}
	if stat.size < 0 || stat.size > int64(input.MaxBytes) {
		return desktopPrivateReadResult{}, userError("too-large", "Desktop private file exceeds its byte limit")
	}
	file, err := duplicateNodeFile(handle, "desktop-private-read")
	if err != nil {
		return desktopPrivateReadResult{}, err
	}
	defer file.Close()
	limited := &io.LimitedReader{R: file, N: int64(input.MaxBytes) + 1}
	content, err := io.ReadAll(limited)
	if err != nil {
		return desktopPrivateReadResult{}, err
	}
	if len(content) > input.MaxBytes {
		return desktopPrivateReadResult{}, userError("too-large", "Desktop private file exceeds its byte limit")
	}
	after, err := statOpenFile(file)
	if err != nil {
		return desktopPrivateReadResult{}, err
	}
	if after.identity != stat.identity || after.size != stat.size || after.changedUnixNano != stat.changedUnixNano {
		return desktopPrivateReadResult{}, userError("concurrent-modification", "Desktop private file changed while it was being read")
	}
	return desktopPrivateReadResult{
		ContentBase64: base64.StdEncoding.EncodeToString(content),
		Size:          len(content),
	}, nil
}

func executeDesktopWriteFile(root *workspaceRoot, input request, exclusive bool) (desktopPrivateMutationResult, error) {
	content, err := base64.StdEncoding.DecodeString(input.Content)
	if err != nil || base64.StdEncoding.EncodeToString(content) != input.Content || len(content) > maxDesktopPrivateFileBytes {
		return desktopPrivateMutationResult{}, userError("invalid-request", "Desktop private file content is invalid")
	}
	parts, _, err := relativeParts(input.Path, false)
	if err != nil {
		return desktopPrivateMutationResult{}, err
	}
	parent, name, err := root.openDesktopParent(parts, false)
	if err != nil {
		return desktopPrivateMutationResult{}, err
	}
	defer closeNode(parent)
	if err := assertDesktopPrivateNode(parent, true); err != nil {
		return desktopPrivateMutationResult{}, err
	}
	if err := lockDirectory(parent); err != nil {
		return desktopPrivateMutationResult{}, err
	}
	defer unlockDirectory(parent)

	var expected *fileIdentity
	existing, stat, openErr := root.openDesktopNodeAt(parent, name, false)
	if openErr == nil {
		defer closeNode(existing)
		if stat.kind != "file" {
			return desktopPrivateMutationResult{}, userError("not-regular", "Desktop private path must name a regular file")
		}
		if err := assertDesktopPrivateNode(existing, false); err != nil {
			return desktopPrivateMutationResult{}, err
		}
		if exclusive {
			return desktopPrivateMutationResult{}, userError("already-exists", "Desktop private file already exists")
		}
		expected = &stat.identity
	} else if !isDesktopNotFound(openErr) {
		return desktopPrivateMutationResult{}, openErr
	}
	if _, err := root.atomicWrite(parent, name, content, expected); err != nil {
		return desktopPrivateMutationResult{}, err
	}
	written, writtenStat, err := root.openDesktopNodeAt(parent, name, false)
	if err != nil {
		return desktopPrivateMutationResult{}, err
	}
	defer closeNode(written)
	if writtenStat.kind != "file" {
		return desktopPrivateMutationResult{}, userError("not-regular", "Desktop private replacement is not a regular file")
	}
	if err := secureDesktopPrivateNode(written, false); err != nil {
		return desktopPrivateMutationResult{}, err
	}
	return desktopPrivateMutationResult{Changed: true}, nil
}

func executeDesktopRemoveFile(root *workspaceRoot, input request) (desktopPrivateMutationResult, error) {
	parts, _, err := relativeParts(input.Path, false)
	if err != nil {
		return desktopPrivateMutationResult{}, err
	}
	parent, name, err := root.openDesktopParent(parts, false)
	if err != nil {
		return desktopPrivateMutationResult{}, err
	}
	defer closeNode(parent)
	if err := assertDesktopPrivateNode(parent, true); err != nil {
		return desktopPrivateMutationResult{}, err
	}
	if err := lockDirectory(parent); err != nil {
		return desktopPrivateMutationResult{}, err
	}
	defer unlockDirectory(parent)
	removed, err := removeDesktopPrivateFileAt(root, parent, name)
	if isDesktopNotFound(err) {
		return desktopPrivateMutationResult{Changed: false}, nil
	}
	if err != nil {
		return desktopPrivateMutationResult{}, err
	}
	return desktopPrivateMutationResult{Changed: removed}, nil
}

func executeDesktopDirectoryEmpty(root *workspaceRoot, input request) (desktopPrivateDirectoryEmptyResult, error) {
	parts, _, err := relativeParts(input.Path, true)
	if err != nil {
		return desktopPrivateDirectoryEmptyResult{}, err
	}
	handle, stat, err := root.openDesktopNode(parts, true)
	if err != nil {
		return desktopPrivateDirectoryEmptyResult{}, err
	}
	defer closeNode(handle)
	if stat.kind != "directory" {
		return desktopPrivateDirectoryEmptyResult{}, userError("not-directory", "Desktop private path must name a directory")
	}
	if err := assertDesktopPrivateNode(handle, true); err != nil {
		return desktopPrivateDirectoryEmptyResult{}, err
	}
	file, err := duplicateNodeFile(handle, "desktop-private-directory")
	if err != nil {
		return desktopPrivateDirectoryEmptyResult{}, err
	}
	defer file.Close()
	entries, err := file.ReadDir(1)
	if err != nil && !errors.Is(err, io.EOF) {
		return desktopPrivateDirectoryEmptyResult{}, err
	}
	return desktopPrivateDirectoryEmptyResult{Empty: len(entries) == 0}, nil
}
