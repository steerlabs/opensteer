//go:build linux || darwin

package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestPackageExportRefusesSymlinks(t *testing.T) {
	workspace := t.TempDir()
	outside := t.TempDir()
	if err := os.Symlink(outside, filepath.Join(workspace, "link")); err != nil {
		t.Fatal(err)
	}
	identityValue, err := executeTest(request{Operation: "directory-identity", Path: ".", Root: workspace})
	if err != nil {
		t.Fatal(err)
	}
	identity := identityValue.(directoryIdentityResult)
	for _, operation := range []string{"create-directory", "write-binary"} {
		if _, err := executeTest(request{Root: workspace, Path: "link/escaped", Operation: operation, Content: "AA==", ExpectedRootIdentity: &identity}); err == nil {
			t.Fatalf("%s followed a symlink", operation)
		}
	}
	entries, err := os.ReadDir(outside)
	if err != nil || len(entries) != 0 {
		t.Fatalf("export wrote outside Agent home: %v", err)
	}
}
