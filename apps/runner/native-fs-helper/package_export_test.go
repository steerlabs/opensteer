package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestPackageExportExclusiveDirectoryAndBinaryRoundTrip(t *testing.T) {
	workspace := t.TempDir()
	invoke := func(input request) (any, error) {
		input.Root = workspace
		input.RootPolicy = "managed-local"
		return executeWithRootPolicy(input, true)
	}
	identityValue, err := invoke(request{Operation: "directory-identity", Path: "."})
	if err != nil {
		t.Fatal(err)
	}
	identity := identityValue.(directoryIdentityResult)
	create := request{Operation: "create-directory", Path: "draft", ExpectedRootIdentity: &identity}
	if _, err := invoke(create); err != nil {
		t.Fatal(err)
	}
	if _, err := invoke(create); err == nil {
		t.Fatal("existing destination folder was accepted")
	}
	content := bytes.Repeat([]byte{0, 255, 128, 10, 13, 42}, 400000)
	write := request{Operation: "write-binary", Path: "draft/image.bin", Content: base64.StdEncoding.EncodeToString(content), ExpectedRootIdentity: &identity}
	encoded, err := json.Marshal(write)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := readRequest(bytes.NewReader(encoded)); err != nil {
		t.Fatalf("binary request over 2 MiB was refused: %v", err)
	}
	if _, err := invoke(write); err != nil {
		t.Fatal(err)
	}
	saved, err := os.ReadFile(filepath.Join(workspace, "draft", "image.bin"))
	if err != nil || !bytes.Equal(saved, content) {
		t.Fatalf("binary source changed: %v", err)
	}
	if _, err := invoke(write); err == nil {
		t.Fatal("existing source file was overwritten")
	}
	if _, err := invoke(request{Operation: "write-binary", Path: "../escape", Content: "AA==", ExpectedRootIdentity: &identity}); err == nil {
		t.Fatal("binary traversal was accepted")
	}
	stale := identity
	stale.FileID = "99999999"
	if _, err := invoke(request{Operation: "create-directory", Path: "other", ExpectedRootIdentity: &stale}); err == nil {
		t.Fatal("replaced Agent home was accepted")
	}
}
