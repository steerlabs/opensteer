package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestRelocateDirectoryDoesNotReplaceAnOccupiedDestination(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "legacy")
	target := filepath.Join(root, "main", "Projects", "research")
	if err := os.MkdirAll(source, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(target, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(source, "keep.txt"), []byte("saved"), 0600); err != nil {
		t.Fatal(err)
	}
	input := request{Operation: "relocate-directory", RootPolicy: "managed-local", Root: root, Path: "legacy", Destination: "main/Projects/research"}
	if _, err := executeWithRootPolicy(input, false); err == nil {
		t.Fatal("occupied destination was accepted")
	}
	if content, err := os.ReadFile(filepath.Join(source, "keep.txt")); err != nil || string(content) != "saved" {
		t.Fatalf("source changed: %q %v", content, err)
	}
	if err := os.Remove(target); err != nil {
		t.Fatal(err)
	}
	if _, err := executeWithRootPolicy(input, false); err != nil {
		t.Fatal(err)
	}
	if content, err := os.ReadFile(filepath.Join(target, "keep.txt")); err != nil || string(content) != "saved" {
		t.Fatalf("relocated bytes: %q %v", content, err)
	}
}
