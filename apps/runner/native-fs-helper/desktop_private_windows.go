//go:build windows

package main

import (
	"errors"
	"path/filepath"
	"runtime"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
)

const desktopFileAllAccess windows.ACCESS_MASK = 0x001f01ff

func ensureDesktopPrivateRoot(rootPath string) (bool, error) {
	cleaned, volumeRoot, err := validatedWindowsRootPath(rootPath)
	if err != nil {
		return false, err
	}
	if strings.EqualFold(cleaned, filepath.Clean(volumeRoot)) {
		return false, userError("invalid-root", "Desktop private filesystem root cannot be the volume root")
	}
	current, err := openAbsoluteDirectory(volumeRoot)
	if err != nil {
		return false, err
	}
	baseStat, err := statForHandle(current, false)
	if err != nil {
		windows.CloseHandle(current)
		return false, err
	}
	root := &workspaceRoot{containment: platformContainment, handle: current, volumeID: baseStat.identity.volumeID}
	defer root.close()
	relative, err := filepath.Rel(volumeRoot, cleaned)
	if err != nil || filepath.IsAbs(relative) || relative == ".." || strings.HasPrefix(relative, `..\`) {
		return false, userError("invalid-root", "Desktop private filesystem root is outside its volume")
	}
	components := strings.Split(relative, `\`)
	createdFinal := false
	createdAncestor := false
	for index, component := range components {
		if !validWindowsComponent(component) {
			return false, userError("invalid-root", "Desktop private filesystem root contains an invalid component")
		}
		final := index == len(components)-1
		var next windows.Handle
		if final || createdAncestor {
			next, err = root.openDesktopDirectoryAt(root.handle, component)
		} else {
			next, err = root.openDirectoryAt(root.handle, component)
		}
		if isWindowsNotFound(err) {
			next, err = root.createDesktopDirectoryAt(root.handle, component)
			if err == nil {
				createdAncestor = true
				createdFinal = final
			}
		} else if err == nil && createdAncestor {
			windows.CloseHandle(next)
			return false, userError("unsafe-permissions", "Desktop private root setup collided with an existing path")
		}
		if err != nil {
			return false, err
		}
		if final || createdAncestor {
			var permissionErr error
			if createdAncestor {
				permissionErr = secureDesktopPrivateNode(next, true)
			} else {
				permissionErr = assertDesktopPrivateNode(next, true)
			}
			if permissionErr != nil {
				windows.CloseHandle(next)
				return false, permissionErr
			}
		}
		windows.CloseHandle(root.handle)
		root.handle = next
	}
	return createdFinal, nil
}

func openDesktopPrivateRoot(rootPath string) (*workspaceRoot, error) {
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
	root := &workspaceRoot{containment: platformContainment, handle: current, volumeID: baseStat.identity.volumeID}
	relative, err := filepath.Rel(volumeRoot, cleaned)
	if err != nil || filepath.IsAbs(relative) || relative == ".." || strings.HasPrefix(relative, `..\`) {
		root.close()
		return nil, userError("invalid-root", "Desktop private filesystem root is outside its volume")
	}
	if relative != "." {
		components := strings.Split(relative, `\`)
		for index, component := range components {
			if !validWindowsComponent(component) {
				root.close()
				return nil, userError("invalid-root", "Desktop private filesystem root contains an invalid component")
			}
			var next windows.Handle
			if index == len(components)-1 {
				next, err = root.openDesktopDirectoryAt(root.handle, component)
			} else {
				next, err = root.openDirectoryAt(root.handle, component)
			}
			if err != nil {
				root.close()
				return nil, err
			}
			windows.CloseHandle(root.handle)
			root.handle = next
		}
	}
	if err := assertDesktopPrivateNode(root.handle, true); err != nil {
		root.close()
		return nil, err
	}
	return root, nil
}

func (root *workspaceRoot) duplicateDesktopRootHandle() (nodeHandle, error) {
	var duplicate windows.Handle
	process := windows.CurrentProcess()
	if err := windows.DuplicateHandle(process, root.handle, process, &duplicate, 0, false, windows.DUPLICATE_SAME_ACCESS); err != nil {
		return windows.InvalidHandle, err
	}
	return duplicate, nil
}

func (root *workspaceRoot) openDesktopDirectoryAt(parent nodeHandle, name string) (nodeHandle, error) {
	handle, err := ntOpenAt(
		parent,
		name,
		windows.FILE_LIST_DIRECTORY|windows.FILE_TRAVERSE|windows.FILE_READ_ATTRIBUTES|windows.READ_CONTROL|windows.WRITE_DAC,
		windows.FILE_OPEN,
		windows.FILE_DIRECTORY_FILE|windows.FILE_OPEN_REPARSE_POINT|windows.FILE_SYNCHRONOUS_IO_NONALERT,
	)
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
		return windows.InvalidHandle, userError("unsafe-parent", "Desktop private path contains a non-directory parent")
	}
	if err := root.assertSameDevice(stat); err != nil {
		closeNode(handle)
		return windows.InvalidHandle, err
	}
	return handle, nil
}

func (root *workspaceRoot) createDesktopDirectoryAt(parent nodeHandle, name string) (nodeHandle, error) {
	descriptor, err := desktopPrivateSecurityDescriptor(true)
	if err != nil {
		return windows.InvalidHandle, err
	}
	handle, err := ntCreateDesktopDirectoryAt(parent, name, descriptor)
	if err != nil {
		return windows.InvalidHandle, err
	}
	if err := secureDesktopPrivateNode(handle, true); err != nil {
		_ = markHandleForDeletion(handle)
		closeNode(handle)
		return windows.InvalidHandle, err
	}
	if err := assertDesktopPrivateNode(parent, true); err != nil {
		_ = markHandleForDeletion(handle)
		closeNode(handle)
		return windows.InvalidHandle, err
	}
	return handle, nil
}

func ntCreateDesktopDirectoryAt(parent windows.Handle, name string, descriptor *windows.SECURITY_DESCRIPTOR) (windows.Handle, error) {
	objectName, err := windows.NewNTUnicodeString(name)
	if err != nil {
		return windows.InvalidHandle, err
	}
	attributes := windows.OBJECT_ATTRIBUTES{
		RootDirectory:      parent,
		ObjectName:         objectName,
		Attributes:         windows.OBJ_CASE_INSENSITIVE | windows.OBJ_DONT_REPARSE,
		SecurityDescriptor: descriptor,
	}
	attributes.Length = uint32(unsafe.Sizeof(attributes))
	var status windows.IO_STATUS_BLOCK
	var allocationSize int64
	var handle windows.Handle
	err = windows.NtCreateFile(
		&handle,
		windows.FILE_LIST_DIRECTORY|windows.FILE_TRAVERSE|windows.FILE_READ_ATTRIBUTES|windows.READ_CONTROL|windows.WRITE_DAC|windows.SYNCHRONIZE,
		&attributes,
		&status,
		&allocationSize,
		windows.FILE_ATTRIBUTE_NORMAL,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE,
		windows.FILE_CREATE,
		windows.FILE_DIRECTORY_FILE|windows.FILE_OPEN_REPARSE_POINT|windows.FILE_SYNCHRONOUS_IO_NONALERT,
		0,
		0,
	)
	if err != nil {
		return windows.InvalidHandle, normalizeWindowsError(err)
	}
	return handle, nil
}

func desktopPrivateSecurityDescriptor(directory bool) (*windows.SECURITY_DESCRIPTOR, error) {
	current, _, err := desktopPrivateSIDs()
	if err != nil {
		return nil, err
	}
	inheritance := ""
	if directory {
		inheritance = "OICI"
	}
	sid := current.String()
	if sid == "" {
		return nil, userError("helper-unavailable", "Windows current-user security identity is unavailable")
	}
	return windows.SecurityDescriptorFromString(
		"O:" + sid + "D:P(A;" + inheritance + ";FA;;;" + sid + ")(A;" + inheritance + ";FA;;;SY)",
	)
}

func (root *workspaceRoot) openDesktopNodeAt(parent nodeHandle, name string, directory bool) (nodeHandle, nodeStat, error) {
	access := uint32(windows.FILE_READ_DATA | windows.FILE_READ_ATTRIBUTES | windows.READ_CONTROL | windows.WRITE_DAC)
	options := uint32(windows.FILE_NON_DIRECTORY_FILE | windows.FILE_OPEN_REPARSE_POINT | windows.FILE_SYNCHRONOUS_IO_NONALERT)
	if directory {
		access = windows.FILE_LIST_DIRECTORY | windows.FILE_TRAVERSE | windows.FILE_READ_ATTRIBUTES | windows.READ_CONTROL | windows.WRITE_DAC
		options = windows.FILE_DIRECTORY_FILE | windows.FILE_OPEN_REPARSE_POINT | windows.FILE_SYNCHRONOUS_IO_NONALERT
	}
	handle, err := ntOpenAt(parent, name, access, windows.FILE_OPEN, options)
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

func (root *workspaceRoot) openDesktopNode(parts []string, directory bool) (nodeHandle, nodeStat, error) {
	if len(parts) == 0 {
		handle, err := root.duplicateDesktopRootHandle()
		if err != nil {
			return windows.InvalidHandle, nodeStat{}, err
		}
		stat, err := statForHandle(handle, false)
		if err != nil {
			closeNode(handle)
			return windows.InvalidHandle, nodeStat{}, err
		}
		return handle, stat, nil
	}
	parent, name, err := root.openDesktopParent(parts, false)
	if err != nil {
		return windows.InvalidHandle, nodeStat{}, err
	}
	defer closeNode(parent)
	return root.openDesktopNodeAt(parent, name, directory)
}

func (root *workspaceRoot) openDesktopParent(parts []string, create bool) (nodeHandle, string, error) {
	if len(parts) == 0 {
		return windows.InvalidHandle, "", userError("invalid-path", "Desktop private path must name an entry")
	}
	current, err := root.duplicateDesktopRootHandle()
	if err != nil {
		return windows.InvalidHandle, "", err
	}
	for _, component := range parts[:len(parts)-1] {
		next, openErr := root.openDesktopDirectoryAt(current, component)
		if isWindowsNotFound(openErr) && create {
			next, openErr = root.createDesktopDirectoryAt(current, component)
		}
		if openErr != nil {
			closeNode(current)
			return windows.InvalidHandle, "", openErr
		}
		if err := assertDesktopPrivateNode(next, true); err != nil {
			closeNode(next)
			closeNode(current)
			return windows.InvalidHandle, "", err
		}
		closeNode(current)
		current = next
	}
	return current, parts[len(parts)-1], nil
}

func secureDesktopPrivateNode(handle nodeHandle, directory bool) error {
	current, system, err := desktopPrivateSIDs()
	if err != nil {
		return err
	}
	descriptor, err := windows.GetSecurityInfo(handle, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION)
	if err != nil {
		return err
	}
	owner, _, err := descriptor.Owner()
	if err != nil || owner == nil || !owner.Equals(current) {
		return userError("unsafe-permissions", "Desktop private path is not owned by the current user")
	}
	inheritance := uint32(windows.NO_INHERITANCE)
	if directory {
		inheritance = windows.SUB_CONTAINERS_AND_OBJECTS_INHERIT
	}
	var pinner runtime.Pinner
	pinner.Pin(current)
	pinner.Pin(system)
	defer pinner.Unpin()
	entries := []windows.EXPLICIT_ACCESS{
		{
			AccessPermissions: desktopFileAllAccess,
			AccessMode:        windows.SET_ACCESS,
			Inheritance:       inheritance,
			Trustee: windows.TRUSTEE{
				TrusteeForm:  windows.TRUSTEE_IS_SID,
				TrusteeType:  windows.TRUSTEE_IS_USER,
				TrusteeValue: windows.TrusteeValueFromSID(current),
			},
		},
		{
			AccessPermissions: desktopFileAllAccess,
			AccessMode:        windows.SET_ACCESS,
			Inheritance:       inheritance,
			Trustee: windows.TRUSTEE{
				TrusteeForm:  windows.TRUSTEE_IS_SID,
				TrusteeType:  windows.TRUSTEE_IS_WELL_KNOWN_GROUP,
				TrusteeValue: windows.TrusteeValueFromSID(system),
			},
		},
	}
	dacl, err := windows.ACLFromEntries(entries, nil)
	if err != nil {
		return err
	}
	if err := windows.SetSecurityInfo(
		handle,
		windows.SE_FILE_OBJECT,
		windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION,
		nil,
		nil,
		dacl,
		nil,
	); err != nil {
		return err
	}
	return assertDesktopPrivateNode(handle, directory)
}

func assertDesktopPrivateNode(handle nodeHandle, directory bool) error {
	current, system, err := desktopPrivateSIDs()
	if err != nil {
		return err
	}
	descriptor, err := windows.GetSecurityInfo(
		handle,
		windows.SE_FILE_OBJECT,
		windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION,
	)
	if err != nil {
		return err
	}
	owner, _, err := descriptor.Owner()
	if err != nil || owner == nil || !owner.Equals(current) {
		return userError("unsafe-permissions", "Desktop private path is not owned by the current user")
	}
	control, _, err := descriptor.Control()
	if err != nil || control&windows.SE_DACL_PROTECTED == 0 {
		return userError("unsafe-permissions", "Desktop private path ACL inheritance is not disabled")
	}
	dacl, _, err := descriptor.DACL()
	if err != nil || dacl == nil || dacl.AceCount != 2 {
		return userError("unsafe-permissions", "Desktop private path ACL grants access to unexpected principals")
	}
	wantedFlags := uint8(windows.NO_INHERITANCE)
	if directory {
		wantedFlags = uint8(windows.OBJECT_INHERIT_ACE | windows.CONTAINER_INHERIT_ACE)
	}
	seenCurrent := false
	seenSystem := false
	for index := uint32(0); index < uint32(dacl.AceCount); index++ {
		var ace *windows.ACCESS_ALLOWED_ACE
		if err := windows.GetAce(dacl, index, &ace); err != nil || ace == nil {
			return userError("unsafe-permissions", "Desktop private path ACL cannot be inspected")
		}
		if ace.Header.AceType != windows.ACCESS_ALLOWED_ACE_TYPE || ace.Header.AceFlags != wantedFlags || ace.Mask != desktopFileAllAccess {
			return userError("unsafe-permissions", "Desktop private path ACL contains an unsafe access rule")
		}
		sid := (*windows.SID)(unsafe.Pointer(&ace.SidStart))
		switch {
		case sid.Equals(current):
			if seenCurrent {
				return userError("unsafe-permissions", "Desktop private path ACL contains duplicate user rules")
			}
			seenCurrent = true
		case sid.Equals(system):
			if seenSystem {
				return userError("unsafe-permissions", "Desktop private path ACL contains duplicate SYSTEM rules")
			}
			seenSystem = true
		default:
			return userError("unsafe-permissions", "Desktop private path ACL grants access to an unexpected principal")
		}
	}
	if !seenCurrent || !seenSystem {
		return userError("unsafe-permissions", "Desktop private path ACL is missing its required principals")
	}
	return nil
}

func desktopPrivateSIDs() (*windows.SID, *windows.SID, error) {
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return nil, nil, err
	}
	current, err := user.User.Sid.Copy()
	if err != nil {
		return nil, nil, err
	}
	system, err := windows.CreateWellKnownSid(windows.WinLocalSystemSid)
	if err != nil {
		return nil, nil, err
	}
	return current, system, nil
}

func removeDesktopPrivateFileAt(root *workspaceRoot, parent nodeHandle, name string) (bool, error) {
	handle, err := ntOpenAt(
		parent,
		name,
		windows.FILE_READ_ATTRIBUTES|windows.READ_CONTROL|windows.DELETE,
		windows.FILE_OPEN,
		windows.FILE_NON_DIRECTORY_FILE|windows.FILE_OPEN_REPARSE_POINT|windows.FILE_SYNCHRONOUS_IO_NONALERT,
	)
	if err != nil {
		return false, err
	}
	defer closeNode(handle)
	stat, err := statForHandle(handle, false)
	if err != nil {
		return false, err
	}
	if err := root.assertSameDevice(stat); err != nil {
		return false, err
	}
	if stat.kind != "file" {
		return false, userError("not-regular", "Desktop private path must name a regular file")
	}
	if err := assertDesktopPrivateNode(handle, false); err != nil {
		return false, err
	}
	if err := markHandleForDeletion(handle); err != nil {
		return false, err
	}
	return true, nil
}

func isDesktopNotFound(err error) bool {
	return isWindowsNotFound(err) || errors.Is(err, windows.ERROR_FILE_NOT_FOUND)
}
