//go:build windows

package main

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"unicode/utf16"
	"unicode/utf8"
	"unsafe"

	"golang.org/x/sys/windows"
)

const platformContainment = "windows-nt-relative-noreparse"

type nodeHandle = windows.Handle

type workspaceRoot struct {
	containment string
	handle      windows.Handle
	volumeID    string
}

type windowsFileIDInfo struct {
	VolumeSerialNumber uint64
	FileID             [16]byte
}

type windowsFileBasicInfo struct {
	CreationTime   int64
	LastAccessTime int64
	LastWriteTime  int64
	ChangeTime     int64
	FileAttributes uint32
	_              uint32
}

type fileRenameInformation struct {
	Flags          uint32
	RootDirectory  windows.Handle
	FileNameLength uint32
	FileName       [1]uint16
}

var directoryMutexes = struct {
	sync.Mutex
	values map[windows.Handle]windows.Handle
}{values: make(map[windows.Handle]windows.Handle)}

func openWorkspaceRoot(rootPath string, requireMountBoundary bool) (*workspaceRoot, error) {
	cleaned, volumeRoot, err := validatedWindowsRootPath(rootPath)
	if err != nil {
		return nil, err
	}
	current, err := openAbsoluteDirectory(volumeRoot)
	if err != nil {
		return nil, err
	}
	baseStat, err := statForHandle(current, false)
	if err != nil {
		windows.CloseHandle(current)
		return nil, err
	}
	root := &workspaceRoot{
		containment: platformContainment,
		handle:      current,
		volumeID:    baseStat.identity.volumeID,
	}
	relative, err := filepath.Rel(volumeRoot, cleaned)
	if err != nil || filepath.IsAbs(relative) || relative == ".." || strings.HasPrefix(relative, `..\`) {
		root.close()
		return nil, userError("invalid-root", "Native filesystem Workspace root is outside its volume")
	}
	if relative != "." {
		for _, component := range strings.Split(relative, `\`) {
			if !validWindowsComponent(component) {
				root.close()
				return nil, userError("invalid-root", "Native filesystem Workspace root contains an invalid component")
			}
			next, openErr := root.openDirectoryAt(root.handle, component)
			if openErr != nil {
				root.close()
				return nil, openErr
			}
			windows.CloseHandle(root.handle)
			root.handle = next
		}
	}
	if requireMountBoundary && !strings.EqualFold(cleaned, filepath.Clean(volumeRoot)) {
		root.close()
		return nil, userError("root-not-mount", "Native filesystem Workspace root is not an isolated volume boundary")
	}
	return root, nil
}

func ensureWorkspaceRoot(rootPath string) (ensureRootResult, error) {
	cleaned, volumeRoot, err := validatedWindowsRootPath(rootPath)
	if err != nil {
		return ensureRootResult{}, err
	}
	current, err := openAbsoluteDirectory(volumeRoot)
	if err != nil {
		return ensureRootResult{}, err
	}
	baseStat, err := statForHandle(current, false)
	if err != nil {
		windows.CloseHandle(current)
		return ensureRootResult{}, err
	}
	root := &workspaceRoot{containment: platformContainment, handle: current, volumeID: baseStat.identity.volumeID}
	defer root.close()
	relative, err := filepath.Rel(volumeRoot, cleaned)
	if err != nil || filepath.IsAbs(relative) || relative == ".." || strings.HasPrefix(relative, `..\`) {
		return ensureRootResult{}, userError("invalid-root", "Native filesystem Workspace root is outside its volume")
	}
	created := false
	if relative != "." {
		components := strings.Split(relative, `\`)
		for index, component := range components {
			if !validWindowsComponent(component) {
				return ensureRootResult{}, userError("invalid-root", "Native filesystem Workspace root contains an invalid component")
			}
			next, openErr := root.openDirectoryAt(root.handle, component)
			if isWindowsNotFound(openErr) {
				createdHandle, _, createErr := root.createDirectoryAt(root.handle, component)
				if createErr == nil {
					created = index == len(components)-1
					next = createdHandle
					openErr = nil
				} else if isAlreadyExists(createErr) {
					next, openErr = root.openDirectoryAt(root.handle, component)
				} else {
					openErr = createErr
				}
			}
			if openErr != nil {
				return ensureRootResult{}, openErr
			}
			windows.CloseHandle(root.handle)
			root.handle = next
		}
	}
	stat, err := statForHandle(root.handle, false)
	if err != nil {
		return ensureRootResult{}, err
	}
	return ensureRootResult{Created: created, Identity: directoryIdentityFromStat(stat)}, nil
}

func validatedWindowsRootPath(rootPath string) (string, string, error) {
	if rootPath == "" || !filepath.IsAbs(rootPath) || strings.ContainsRune(rootPath, 0) || len(rootPath) > 16*1024 {
		return "", "", userError("invalid-root", "Native filesystem Workspace root is invalid")
	}
	namespacePath := strings.ReplaceAll(rootPath, "/", `\`)
	if hasWindowsDeviceNamespace(namespacePath) {
		return "", "", userError("invalid-root", "Native filesystem Workspace root uses an unsupported device namespace")
	}
	cleaned := filepath.Clean(rootPath)
	volume := filepath.VolumeName(cleaned)
	if !validWindowsVolumeName(volume) {
		return "", "", userError("invalid-root", "Native filesystem Workspace root has no volume")
	}
	return cleaned, volume + `\`, nil
}

func openAbsoluteDirectory(path string) (windows.Handle, error) {
	encoded, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return windows.InvalidHandle, err
	}
	handle, err := windows.CreateFile(
		encoded,
		windows.GENERIC_READ,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE,
		nil,
		windows.OPEN_EXISTING,
		windows.FILE_FLAG_BACKUP_SEMANTICS|windows.FILE_FLAG_OPEN_REPARSE_POINT,
		0,
	)
	if err != nil {
		return windows.InvalidHandle, err
	}
	if _, err := statForHandle(handle, false); err != nil {
		windows.CloseHandle(handle)
		return windows.InvalidHandle, err
	}
	return handle, nil
}

func (root *workspaceRoot) close() { _ = windows.CloseHandle(root.handle) }

func closeNode(handle nodeHandle) { _ = windows.CloseHandle(handle) }

func statNodeHandle(handle nodeHandle) (nodeStat, error) {
	return statForHandle(handle, false)
}

func duplicateNodeFile(handle nodeHandle, name string) (*os.File, error) {
	var duplicate windows.Handle
	process := windows.CurrentProcess()
	if err := windows.DuplicateHandle(
		process,
		handle,
		process,
		&duplicate,
		0,
		false,
		windows.DUPLICATE_SAME_ACCESS,
	); err != nil {
		return nil, err
	}
	return os.NewFile(uintptr(duplicate), name), nil
}

func statOpenFile(file *os.File) (nodeStat, error) {
	return statForHandle(windows.Handle(file.Fd()), false)
}

func (root *workspaceRoot) probe() error {
	duplicate, err := duplicateNodeFile(root.handle, "workspace-root-probe")
	if err == nil {
		err = duplicate.Close()
	}
	return err
}

func relativeParts(value string, allowRoot bool) ([]string, string, error) {
	if value == "." && allowRoot {
		return nil, ".", nil
	}
	if value == "" || strings.HasPrefix(value, "/") || strings.HasPrefix(value, `\`) || strings.ContainsRune(value, 0) || len(value) > 4096 {
		return nil, "", userError("invalid-path", "Path must be relative to the workspace")
	}
	parts := strings.Split(value, "/")
	for _, part := range parts {
		if part == "" || part == "." || part == ".." {
			return nil, "", userError("outside-workspace", "Path escapes the workspace")
		}
		if !validWindowsComponent(part) {
			return nil, "", userError("invalid-path", "Workspace path component is invalid on Windows")
		}
	}
	return parts, strings.Join(parts, "/"), nil
}

func validWindowsComponent(value string) bool {
	if value == "" || len(utf16.Encode([]rune(value))) > 255 || strings.HasSuffix(value, ".") || strings.HasSuffix(value, " ") {
		return false
	}
	for _, character := range value {
		if character < 32 || strings.ContainsRune(`<>:"/\|?*`, character) {
			return false
		}
	}
	base := strings.TrimRight(strings.ToUpper(strings.SplitN(value, ".", 2)[0]), " ")
	if base == "CON" || base == "PRN" || base == "AUX" || base == "NUL" || base == "CONIN$" || base == "CONOUT$" {
		return false
	}
	if len(base) == 4 && (strings.HasPrefix(base, "COM") || strings.HasPrefix(base, "LPT")) && base[3] >= '1' && base[3] <= '9' {
		return false
	}
	if len([]rune(base)) == 4 && (strings.HasPrefix(base, "COM") || strings.HasPrefix(base, "LPT")) && strings.ContainsRune("¹²³", []rune(base)[3]) {
		return false
	}
	return true
}

func nativeFilesComponent(value []byte) (string, error) {
	if !utf8.Valid(value) {
		return "", userError("invalid-path", "Files key is not a valid Windows filename")
	}
	component := string(value)
	if !validWindowsComponent(component) {
		return "", userError("invalid-path", "Files key contains an invalid Windows path component")
	}
	return component, nil
}

func hasWindowsDeviceNamespace(value string) bool {
	lower := strings.ToLower(value)
	return strings.HasPrefix(lower, `\\?\`) ||
		strings.HasPrefix(lower, `\\.\`) ||
		strings.HasPrefix(lower, `\??\`) ||
		strings.HasPrefix(lower, `\\??\`) ||
		strings.HasPrefix(lower, `\device\`) ||
		strings.HasPrefix(lower, `\global??\`) ||
		strings.HasPrefix(lower, `\\globalroot\`)
}

func validWindowsVolumeName(value string) bool {
	if len(value) == 2 && ((value[0] >= 'A' && value[0] <= 'Z') || (value[0] >= 'a' && value[0] <= 'z')) && value[1] == ':' {
		return true
	}
	if !strings.HasPrefix(value, `\\`) {
		return false
	}
	parts := strings.Split(strings.TrimPrefix(value, `\\`), `\`)
	return len(parts) == 2 && validUncAuthority(parts[0]) && validWindowsComponent(parts[1])
}

func validUncAuthority(value string) bool {
	if value == "" || value == "." || value == ".." || strings.HasSuffix(value, ".") || strings.HasSuffix(value, " ") {
		return false
	}
	for _, character := range value {
		if character < 32 || strings.ContainsRune(`<>:"/\|?*`, character) {
			return false
		}
	}
	return true
}

func (root *workspaceRoot) openNode(parts []string) (nodeHandle, nodeStat, error) {
	if len(parts) == 0 {
		var handle windows.Handle
		process := windows.CurrentProcess()
		if err := windows.DuplicateHandle(process, root.handle, process, &handle, 0, false, windows.DUPLICATE_SAME_ACCESS); err != nil {
			return windows.InvalidHandle, nodeStat{}, err
		}
		stat, err := statForHandle(handle, false)
		if err != nil {
			closeNode(handle)
			return windows.InvalidHandle, nodeStat{}, err
		}
		if err := root.assertSameDevice(stat); err != nil {
			closeNode(handle)
			return windows.InvalidHandle, nodeStat{}, err
		}
		return handle, stat, nil
	}
	parent, name, err := root.openParent(parts, false)
	if err != nil {
		return windows.InvalidHandle, nodeStat{}, err
	}
	defer closeNode(parent)
	return root.openNodeAt(parent, name)
}

func (root *workspaceRoot) openNodeAt(parent nodeHandle, name string) (nodeHandle, nodeStat, error) {
	handle, err := ntOpenAt(parent, name, windows.FILE_READ_DATA|windows.FILE_READ_ATTRIBUTES, windows.FILE_OPEN, windows.FILE_OPEN_REPARSE_POINT|windows.FILE_SYNCHRONOUS_IO_NONALERT)
	if err != nil {
		return windows.InvalidHandle, nodeStat{}, err
	}
	stat, err := statForHandle(handle, false)
	if err != nil {
		closeNode(handle)
		return windows.InvalidHandle, nodeStat{}, err
	}
	if err := root.assertSameDevice(stat); err != nil {
		closeNode(handle)
		return windows.InvalidHandle, nodeStat{}, err
	}
	return handle, stat, nil
}

func (root *workspaceRoot) statNodeAt(parent nodeHandle, name string) (nodeStat, error) {
	handle, err := ntOpenAt(parent, name, windows.FILE_READ_ATTRIBUTES|windows.SYNCHRONIZE, windows.FILE_OPEN, windows.FILE_OPEN_REPARSE_POINT|windows.FILE_SYNCHRONOUS_IO_NONALERT)
	if err != nil {
		return nodeStat{}, err
	}
	defer closeNode(handle)
	stat, err := statForHandle(handle, true)
	if err != nil {
		return nodeStat{}, err
	}
	if err := root.assertSameDevice(stat); err != nil {
		return nodeStat{}, err
	}
	return stat, nil
}

func (root *workspaceRoot) openDirectoryAt(parent nodeHandle, name string) (nodeHandle, error) {
	handle, err := ntOpenAt(parent, name, windows.FILE_LIST_DIRECTORY|windows.FILE_TRAVERSE|windows.FILE_READ_ATTRIBUTES, windows.FILE_OPEN, windows.FILE_DIRECTORY_FILE|windows.FILE_OPEN_REPARSE_POINT|windows.FILE_SYNCHRONOUS_IO_NONALERT)
	if err != nil {
		return windows.InvalidHandle, err
	}
	stat, err := statForHandle(handle, false)
	if err != nil {
		closeNode(handle)
		return windows.InvalidHandle, err
	}
	if stat.kind != "directory" {
		closeNode(handle)
		return windows.InvalidHandle, userError("unsafe-parent", "Workspace path contains a non-directory parent")
	}
	if err := root.assertSameDevice(stat); err != nil {
		closeNode(handle)
		return windows.InvalidHandle, err
	}
	return handle, nil
}

func (root *workspaceRoot) createDirectoryAt(parent nodeHandle, name string) (nodeHandle, nodeStat, error) {
	handle, err := ntOpenAt(parent, name, windows.FILE_READ_ATTRIBUTES, windows.FILE_CREATE, windows.FILE_DIRECTORY_FILE|windows.FILE_OPEN_REPARSE_POINT|windows.FILE_SYNCHRONOUS_IO_NONALERT)
	if err != nil {
		return windows.InvalidHandle, nodeStat{}, err
	}
	stat, err := statForHandle(handle, false)
	if err != nil {
		closeNode(handle)
		return windows.InvalidHandle, nodeStat{}, err
	}
	if err := root.assertSameDevice(stat); err != nil {
		closeNode(handle)
		return windows.InvalidHandle, nodeStat{}, err
	}
	return handle, stat, nil
}

func isAlreadyExists(err error) bool {
	return errors.Is(err, windows.ERROR_ALREADY_EXISTS) || errors.Is(err, windows.ERROR_FILE_EXISTS)
}

func ntOpenAt(parent windows.Handle, name string, access uint32, disposition uint32, options uint32) (windows.Handle, error) {
	objectName, err := windows.NewNTUnicodeString(name)
	if err != nil {
		return windows.InvalidHandle, err
	}
	attributes := windows.OBJECT_ATTRIBUTES{
		RootDirectory: parent,
		ObjectName:    objectName,
		Attributes:    windows.OBJ_CASE_INSENSITIVE | windows.OBJ_DONT_REPARSE,
	}
	attributes.Length = uint32(unsafe.Sizeof(attributes))
	var status windows.IO_STATUS_BLOCK
	var allocationSize int64
	var handle windows.Handle
	err = windows.NtCreateFile(
		&handle,
		access|windows.SYNCHRONIZE,
		&attributes,
		&status,
		&allocationSize,
		windows.FILE_ATTRIBUTE_NORMAL,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE,
		disposition,
		options,
		0,
		0,
	)
	if err != nil {
		return windows.InvalidHandle, normalizeWindowsError(err)
	}
	return handle, nil
}

func statForHandle(handle windows.Handle, allowReparse bool) (nodeStat, error) {
	var information windows.ByHandleFileInformation
	if err := windows.GetFileInformationByHandle(handle, &information); err != nil {
		return nodeStat{}, err
	}
	if information.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 && !allowReparse {
		return nodeStat{}, userError("symlink-denied", "Workspace paths containing reparse points are not available to Native tools")
	}
	var identifier windowsFileIDInfo
	if err := windows.GetFileInformationByHandleEx(
		handle,
		windows.FileIdInfo,
		(*byte)(unsafe.Pointer(&identifier)),
		uint32(unsafe.Sizeof(identifier)),
	); err != nil {
		return nodeStat{}, userError("helper-unavailable", "Windows filesystem identity is unavailable on this volume")
	}
	if identifier.FileID == ([16]byte{}) {
		// Microsoft documents an all-zero FILE_ID_128 as the sentinel for a
		// filesystem that cannot provide stable 128-bit identity. It must not
		// be persisted as proof that a managed root has not been replaced.
		return nodeStat{}, userError("helper-unavailable", "Windows filesystem identity is unavailable on this volume")
	}
	var basic windowsFileBasicInfo
	if err := windows.GetFileInformationByHandleEx(
		handle,
		windows.FileBasicInfo,
		(*byte)(unsafe.Pointer(&basic)),
		uint32(unsafe.Sizeof(basic)),
	); err != nil {
		return nodeStat{}, userError("helper-unavailable", "Windows filesystem timestamps are unavailable on this volume")
	}
	kind := "file"
	if information.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
		kind = "symlink"
	} else if information.FileAttributes&windows.FILE_ATTRIBUTE_DIRECTORY != 0 {
		kind = "directory"
	}
	mode := uint32(0o444)
	if information.FileAttributes&windows.FILE_ATTRIBUTE_READONLY == 0 {
		mode |= 0o200
	}
	if kind == "directory" {
		mode |= 0o111
	}
	return nodeStat{
		changedUnixNano: windowsFileTimestampUnixNano(basic.ChangeTime),
		identity: fileIdentity{
			fileID:   hex.EncodeToString(identifier.FileID[:]),
			volumeID: fmt.Sprintf("%d", identifier.VolumeSerialNumber),
		},
		kind:             kind,
		mode:             mode,
		modifiedUnixNano: windowsFileTimestampUnixNano(basic.LastWriteTime),
		size:             int64(uint64(information.FileSizeHigh)<<32 | uint64(information.FileSizeLow)),
	}, nil
}

func windowsFileTimestampUnixNano(value int64) int64 {
	return (value - 116_444_736_000_000_000) * 100
}

func (root *workspaceRoot) assertSameDevice(stat nodeStat) error {
	if stat.identity.volumeID != root.volumeID {
		return userError("cross-device", "Nested filesystem mounts are unavailable to Native tools")
	}
	return nil
}

func (root *workspaceRoot) openParent(parts []string, create bool) (nodeHandle, string, error) {
	if len(parts) == 0 {
		return windows.InvalidHandle, "", userError("invalid-path", "Path must name a file inside the Workspace")
	}
	var current windows.Handle
	process := windows.CurrentProcess()
	if err := windows.DuplicateHandle(process, root.handle, process, &current, 0, false, windows.DUPLICATE_SAME_ACCESS); err != nil {
		return windows.InvalidHandle, "", err
	}
	for _, part := range parts[:len(parts)-1] {
		next, openErr := root.openDirectoryAt(current, part)
		if openErr != nil && create && isWindowsNotFound(openErr) {
			created, createErr := ntOpenAt(current, part, windows.FILE_READ_ATTRIBUTES, windows.FILE_CREATE, windows.FILE_DIRECTORY_FILE|windows.FILE_OPEN_REPARSE_POINT|windows.FILE_SYNCHRONOUS_IO_NONALERT)
			if createErr != nil && !errors.Is(createErr, windows.ERROR_ALREADY_EXISTS) && !errors.Is(createErr, windows.ERROR_FILE_EXISTS) {
				closeNode(current)
				return windows.InvalidHandle, "", createErr
			}
			if createErr == nil {
				closeNode(created)
			}
			next, openErr = root.openDirectoryAt(current, part)
		}
		if openErr != nil {
			closeNode(current)
			return windows.InvalidHandle, "", openErr
		}
		closeNode(current)
		current = next
	}
	return current, parts[len(parts)-1], nil
}

func (root *workspaceRoot) atomicWrite(parent nodeHandle, name string, content []byte, expected *fileIdentity) (string, error) {
	if err := root.assertTargetIdentity(parent, name, expected); err != nil {
		return "", err
	}
	random := make([]byte, 16)
	if _, err := rand.Read(random); err != nil {
		return "", err
	}
	temporary := ".opensteer-write-" + hex.EncodeToString(random)
	handle, err := ntOpenAt(parent, temporary, windows.FILE_WRITE_DATA|windows.FILE_READ_ATTRIBUTES|windows.DELETE, windows.FILE_CREATE, windows.FILE_NON_DIRECTORY_FILE|windows.FILE_OPEN_REPARSE_POINT|windows.FILE_SYNCHRONOUS_IO_NONALERT|windows.FILE_WRITE_THROUGH)
	if err != nil {
		return "", err
	}
	cleanup := true
	defer func() {
		if cleanup {
			_ = markHandleForDeletion(handle)
		}
		closeNode(handle)
	}()

	written := 0
	for written < len(content) {
		var count uint32
		if err := windows.WriteFile(handle, content[written:], &count, nil); err != nil {
			return "", err
		}
		if count == 0 {
			return "", windows.ERROR_WRITE_FAULT
		}
		written += int(count)
	}
	if err := windows.FlushFileBuffers(handle); err != nil {
		return "", err
	}
	if err := root.assertTargetIdentity(parent, name, expected); err != nil {
		return "", err
	}
	if err := renameHandleAt(handle, parent, name); err != nil {
		return "", err
	}
	cleanup = false
	// FILE_WRITE_THROUGH is a property of this file object, so Windows flushes
	// both the content and metadata changes (including the rename) issued on
	// the handle before completing them. FlushFileBuffers above makes the data
	// ordering explicit; the write-through rename supplies the durable
	// namespace commit without requiring broad write access on the directory.
	return "synced", nil
}

func (root *workspaceRoot) assertTargetIdentity(parent nodeHandle, name string, expected *fileIdentity) error {
	stat, err := root.statNodeAt(parent, name)
	if err == nil {
		if stat.kind != "file" {
			return userError("not-regular", "Workspace write target must be a regular file or a new path")
		}
		if expected != nil && stat.identity != *expected {
			return userError("concurrent-modification", "Workspace file changed while replace_text was running")
		}
		return nil
	}
	if !isWindowsNotFound(err) {
		return err
	}
	if expected != nil {
		return userError("concurrent-modification", "Workspace file changed while replace_text was running")
	}
	return nil
}

func renameHandleAt(handle windows.Handle, parent windows.Handle, name string) error {
	encoded, err := windows.UTF16FromString(name)
	if err != nil {
		return err
	}
	nameBytes := (len(encoded) - 1) * 2
	var layout fileRenameInformation
	buffer := make([]byte, int(unsafe.Offsetof(layout.FileName))+nameBytes)
	information := (*fileRenameInformation)(unsafe.Pointer(&buffer[0]))
	information.Flags = windows.FILE_RENAME_REPLACE_IF_EXISTS | windows.FILE_RENAME_POSIX_SEMANTICS
	information.RootDirectory = parent
	information.FileNameLength = uint32(nameBytes)
	copy((*[windows.MAX_LONG_PATH]uint16)(unsafe.Pointer(&information.FileName[0]))[:nameBytes/2:nameBytes/2], encoded[:len(encoded)-1])
	var status windows.IO_STATUS_BLOCK
	return normalizeWindowsError(windows.NtSetInformationFile(handle, &status, &buffer[0], uint32(len(buffer)), windows.FileRenameInformation))
}

func markHandleForDeletion(handle windows.Handle) error {
	flags := uint32(windows.FILE_DISPOSITION_DELETE | windows.FILE_DISPOSITION_POSIX_SEMANTICS | windows.FILE_DISPOSITION_IGNORE_READONLY_ATTRIBUTE)
	var status windows.IO_STATUS_BLOCK
	if err := windows.NtSetInformationFile(handle, &status, (*byte)(unsafe.Pointer(&flags)), uint32(unsafe.Sizeof(flags)), windows.FileDispositionInformationEx); err == nil {
		return nil
	}
	deleteFile := byte(1)
	return normalizeWindowsError(windows.NtSetInformationFile(handle, &status, &deleteFile, 1, windows.FileDispositionInformation))
}

func directoryIdentityFromStat(stat nodeStat) directoryIdentityResult {
	return directoryIdentityResult{
		FileID: stat.identity.fileID, Kind: "windows", VolumeID: stat.identity.volumeID,
	}
}

func lockDirectory(handle nodeHandle) error {
	stat, err := statForHandle(handle, false)
	if err != nil {
		return err
	}
	name, err := windows.UTF16PtrFromString(`Local\Opensteer.NativeFs.` + stat.identity.volumeID + `.` + stat.identity.fileID)
	if err != nil {
		return err
	}
	mutex, err := windows.CreateMutex(nil, false, name)
	if err != nil {
		return err
	}
	result, err := windows.WaitForSingleObject(mutex, windows.INFINITE)
	if err != nil || (result != windows.WAIT_OBJECT_0 && result != windows.WAIT_ABANDONED) {
		windows.CloseHandle(mutex)
		if err != nil {
			return err
		}
		return windows.ERROR_LOCK_FAILED
	}
	directoryMutexes.Lock()
	directoryMutexes.values[handle] = mutex
	directoryMutexes.Unlock()
	return nil
}

func unlockDirectory(handle nodeHandle) {
	directoryMutexes.Lock()
	mutex := directoryMutexes.values[handle]
	delete(directoryMutexes.values, handle)
	directoryMutexes.Unlock()
	if mutex != 0 {
		_ = windows.ReleaseMutex(mutex)
		_ = windows.CloseHandle(mutex)
	}
}

func normalizeWindowsError(err error) error {
	if err == nil {
		return nil
	}
	var status windows.NTStatus
	if errors.As(err, &status) {
		return status.Errno()
	}
	return err
}

func isWindowsNotFound(err error) bool {
	return errors.Is(err, windows.ERROR_FILE_NOT_FOUND) || errors.Is(err, windows.ERROR_PATH_NOT_FOUND)
}

func platformPublicError(err error) (string, string, bool) {
	err = normalizeWindowsError(err)
	switch {
	case isWindowsNotFound(err):
		return "not-found", "Workspace path does not exist", true
	case errors.Is(err, windows.ERROR_CANT_ACCESS_FILE):
		return "symlink-denied", "Workspace paths containing reparse points are not available to Native tools", true
	case errors.Is(err, windows.ERROR_DIRECTORY):
		return "unsafe-parent", "Workspace path contains a reparse point or non-directory parent; reparse points are unavailable", true
	case errors.Is(err, windows.ERROR_NOT_SAME_DEVICE):
		return "cross-device", "Nested filesystem mounts are unavailable to Native tools", true
	case errors.Is(err, windows.ERROR_ACCESS_DENIED), errors.Is(err, windows.ERROR_PRIVILEGE_NOT_HELD):
		return "permission-denied", "Workspace path is not accessible", true
	case errors.Is(err, windows.ERROR_INVALID_FUNCTION), errors.Is(err, windows.ERROR_INVALID_PARAMETER), errors.Is(err, windows.ERROR_NOT_SUPPORTED):
		return "helper-unavailable", "Native filesystem containment is unavailable on this system", true
	default:
		var errno syscall.Errno
		if errors.As(err, &errno) && errno == windows.STATUS_REPARSE_POINT_ENCOUNTERED.Errno() {
			return "symlink-denied", "Workspace paths containing reparse points are not available to Native tools", true
		}
		return "", "", false
	}
}
