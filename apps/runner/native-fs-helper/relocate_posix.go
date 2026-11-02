//go:build linux || darwin

package main

import "golang.org/x/sys/unix"

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
	handle, err := root.openDirectoryAt(source, name)
	if err != nil {
		return nil, err
	}
	defer closeNode(handle)
	target, destination, err := root.openParent(targetParts, true)
	if err != nil {
		return nil, err
	}
	defer closeNode(target)
	if err := renameDirectoryExclusive(int(source), name, int(target), destination); err != nil {
		return nil, err
	}
	if err := unix.Fsync(int(target)); err != nil {
		return nil, err
	}
	if err := unix.Fsync(int(source)); err != nil {
		return nil, err
	}
	return map[string]any{}, nil
}
