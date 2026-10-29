//go:build linux

package main

import (
	"encoding/base64"
	"os"
	"path/filepath"
	"testing"
)

func TestFilesOpaqueNamesPreserveNonUTF8BytesOnLinux(t *testing.T) {
	workspace := t.TempDir()
	names := []string{
		string([]byte{'n', 'o', 'n', '-', 0xff}),
		string([]byte{'n', 'o', 'n', '-', 0xfe}),
		`non-\xFF`,
	}
	for _, name := range names {
		if err := os.WriteFile(filepath.Join(workspace, name), []byte("raw"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	expected := expectedRootIdentity(t, workspace)
	listed, err := executeTest(request{
		ExpectedRootIdentity: &expected,
		Limit:                10,
		Operation:            "files-list",
		Root:                 workspace,
	})
	if err != nil {
		t.Fatal(err)
	}
	entries := listed.(filesListResult).Entries
	if len(entries) != 3 {
		t.Fatalf("non-UTF-8 entry was not preserved: %#v", entries)
	}
	byName := make(map[string]filesEntry, len(entries))
	for _, entry := range entries {
		byName[entry.NameBase64] = entry
	}
	encodedName := base64.RawURLEncoding.EncodeToString([]byte(names[0]))
	entry, exists := byName[encodedName]
	if !exists || entry.DisplayName != "non-\\xFF" {
		t.Fatalf("non-UTF-8 display name was not escaped losslessly: %#v", entries)
	}
	literal := byName[base64.RawURLEncoding.EncodeToString([]byte(`non-\xFF`))]
	if literal.DisplayName != `non-\\xFF` || literal.DisplayName == entry.DisplayName {
		t.Fatalf("escaped display names collided: raw=%#v literal=%#v", entry, literal)
	}
	read, err := executeTest(request{
		ExpectedRootIdentity: &expected,
		MaxBytes:             10,
		Operation:            "files-read-range",
		PathSegmentsBase64:   []string{encodedName},
		Root:                 workspace,
	})
	if err != nil {
		t.Fatal(err)
	}
	content, err := base64.StdEncoding.DecodeString(read.(filesReadRangeResult).ContentBase64)
	if err != nil || string(content) != "raw" {
		t.Fatalf("non-UTF-8 entry could not be read: %q, %v", content, err)
	}
}
