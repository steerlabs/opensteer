//go:build windows

package main

import "golang.org/x/sys/windows"

func (root *workspaceRoot) relocateDirectory(input request) (any, error) {
	parts, _, err := relativeParts(input.Path, false)
	if err != nil {
		return nil, err
	}
	targetParts, _, err := relativeParts(input.Destination, false)
	if err != nil {
		return nil, err
	}
	source, name, err := root.openParent(parts, false)
	if err != nil {
		return nil, err
	}
	defer closeNode(source)
	handle, err := ntOpenAt(source, name, windows.FILE_READ_ATTRIBUTES|windows.DELETE, windows.FILE_OPEN, windows.FILE_DIRECTORY_FILE|windows.FILE_OPEN_REPARSE_POINT|windows.FILE_SYNCHRONOUS_IO_NONALERT|windows.FILE_WRITE_THROUGH)
	if err != nil {
		return nil, err
	}
	defer closeNode(handle)
	stat, err := statForHandle(handle, false)
	if err != nil {
		return nil, err
	}
	if err := root.assertSameDevice(stat); err != nil {
		return nil, err
	}
	target, destination, err := root.openParent(targetParts, true)
	if err != nil {
		return nil, err
	}
	defer closeNode(target)
	if err := renameHandleAtFlags(handle, target, destination, 0); err != nil {
		return nil, err
	}
	return map[string]any{}, nil
}
