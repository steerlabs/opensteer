package main

import "encoding/base64"

const maxBinaryFileBytes = 24 * 1024 * 1024
const maxBinaryRequestBytes = 34 * 1024 * 1024

type createdDirectoryResult struct {
	Identity directoryIdentityResult `json:"identity"`
	Path     string                  `json:"path"`
}

func executeCreateDirectory(root *filesystemRoot, input request) (createdDirectoryResult, error) {
	if err := assertExpectedFilesRoot(root, input.ExpectedRootIdentity); err != nil {
		return createdDirectoryResult{}, err
	}
	parts, display, err := relativeParts(input.Path, false)
	if err != nil {
		return createdDirectoryResult{}, err
	}
	parent, name, err := root.openParent(parts, false)
	if err != nil {
		return createdDirectoryResult{}, err
	}
	defer closeNode(parent)
	directory, stat, err := root.createDirectoryAt(parent, name)
	if isAlreadyExists(err) {
		return createdDirectoryResult{}, userError("already-exists", "Destination folder already exists; choose a new folder")
	}
	if err != nil {
		return createdDirectoryResult{}, err
	}
	defer closeNode(directory)
	return createdDirectoryResult{Identity: directoryIdentityFromStat(stat), Path: display}, nil
}

func executeWriteBinary(root *filesystemRoot, input request) (writeResult, error) {
	if err := assertExpectedFilesRoot(root, input.ExpectedRootIdentity); err != nil {
		return writeResult{}, err
	}
	content, err := base64.StdEncoding.DecodeString(input.Content)
	if err != nil || len(content) > maxBinaryFileBytes || base64.StdEncoding.EncodeToString(content) != input.Content {
		return writeResult{}, userError("invalid-request", "Binary file content is invalid or exceeds 24 MiB")
	}
	parts, display, err := relativeParts(input.Path, false)
	if err != nil {
		return writeResult{}, err
	}
	parent, name, err := root.openParent(parts, false)
	if err != nil {
		return writeResult{}, err
	}
	defer closeNode(parent)
	durability, err := root.createBinaryFileAt(parent, name, content)
	if err != nil {
		return writeResult{}, err
	}
	return writeResult{BytesWritten: len(content), Durability: durability, Path: display}, nil
}
