//go:build linux || darwin

package main

import (
	"bytes"
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

func TestWorkspaceOperations(t *testing.T) {
	workspace := t.TempDir()
	if err := os.Mkdir(filepath.Join(workspace, "docs"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(workspace, "docs", "a.txt"), []byte("Needle one\nneedle two\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(t.TempDir(), filepath.Join(workspace, "outside-link")); err != nil {
		t.Fatal(err)
	}

	listed, err := executeTest(request{
		MaxDepth: 2, MaxEntries: 100, Operation: "list", Path: ".", Root: workspace,
	})
	if err != nil {
		t.Fatal(err)
	}
	entries := listed.(listResult).Entries
	if len(entries) != 3 || entries[0].Path != "docs" || entries[1].Path != "docs/a.txt" || entries[2].Type != "symlink" {
		t.Fatalf("unexpected listing: %#v", entries)
	}

	read, err := executeTest(request{Operation: "read", Path: "docs/a.txt", Root: workspace})
	if err != nil {
		t.Fatal(err)
	}
	content, err := base64.StdEncoding.DecodeString(read.(readResult).ContentBase64)
	if err != nil || string(content) != "Needle one\nneedle two\n" {
		t.Fatalf("unexpected read: %q, %v", content, err)
	}

	searched, err := executeTest(request{
		CaseSensitive: false, MaxEntries: 100, MaxResults: 10, Operation: "search", Path: ".", Query: "needle", Root: workspace,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(searched.(searchResult).Matches) != 2 {
		t.Fatalf("unexpected search: %#v", searched)
	}

	if _, err := executeTest(request{Content: "created", Operation: "write", Path: "nested/new.txt", Root: workspace}); err != nil {
		t.Fatal(err)
	}
	if _, err := executeTest(request{NewText: "center", OldText: "Needle", Operation: "replace", Path: "docs/a.txt", Root: workspace}); err != nil {
		t.Fatal(err)
	}
	updated, err := os.ReadFile(filepath.Join(workspace, "docs", "a.txt"))
	if err != nil || !strings.HasPrefix(string(updated), "center one") {
		t.Fatalf("unexpected replacement: %q, %v", updated, err)
	}
}

func TestDesktopPrivateAuthorityUsesPinnedRootAndPrivateFiles(t *testing.T) {
	rootPath := filepath.Join(t.TempDir(), "Opensteer")
	createdValue, err := executeWithRootPolicy(request{
		Operation: "desktop-ensure-root", Root: rootPath, RootPolicy: "desktop-private",
	}, true)
	if err != nil {
		t.Fatal(err)
	}
	created := createdValue.(desktopPrivateRootResult)
	if !created.Created || created.Identity.Kind != "posix" {
		t.Fatalf("unexpected Desktop root: %#v", created)
	}
	requestFor := func(operation, relativePath string) request {
		return request{
			ExpectedRootIdentity: &created.Identity,
			Operation:            operation,
			Path:                 relativePath,
			Root:                 rootPath,
			RootPolicy:           "desktop-private",
		}
	}
	if _, err := executeWithRootPolicy(requestFor("desktop-ensure-directory", "private"), true); err != nil {
		t.Fatal(err)
	}
	create := requestFor("desktop-create-file", "private/secret.json")
	create.Content = base64.StdEncoding.EncodeToString([]byte("secret"))
	if _, err := executeWithRootPolicy(create, true); err != nil {
		t.Fatal(err)
	}
	if _, err := executeWithRootPolicy(create, true); !hasHelperCode(err, "already-exists") {
		t.Fatalf("exclusive Desktop write replaced an existing file: %v", err)
	}
	read := requestFor("desktop-read-file", "private/secret.json")
	read.MaxBytes = 32
	readValue, err := executeWithRootPolicy(read, true)
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := base64.StdEncoding.DecodeString(readValue.(desktopPrivateReadResult).ContentBase64)
	if err != nil || string(decoded) != "secret" {
		t.Fatalf("unexpected Desktop private read: %q, %v", decoded, err)
	}
	metadata, err := os.Stat(filepath.Join(rootPath, "private", "secret.json"))
	if err != nil || metadata.Mode().Perm() != 0600 {
		t.Fatalf("Desktop private file is not owner-only: %#o, %v", metadata.Mode().Perm(), err)
	}

	original := rootPath + ".original"
	if err := os.Rename(rootPath, original); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(rootPath, 0700); err != nil {
		t.Fatal(err)
	}
	if _, err := executeWithRootPolicy(read, true); !hasHelperCode(err, "root-replaced") {
		t.Fatalf("Desktop private authority accepted a replaced root: %v", err)
	}
}

func TestFilesOperationsUseIdentityBoundOpaqueSegmentsAndRevisions(t *testing.T) {
	workspace := t.TempDir()
	rawName := "raw-☃"
	if err := os.WriteFile(filepath.Join(workspace, rawName), []byte("opaque-content"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(workspace, "second.txt"), []byte("second"), 0600); err != nil {
		t.Fatal(err)
	}
	expected := expectedRootIdentity(t, workspace)
	firstValue, err := executeTest(request{
		ExpectedRootIdentity: &expected,
		Limit:                1,
		Operation:            "files-list",
		Root:                 workspace,
	})
	if err != nil {
		t.Fatal(err)
	}
	first := firstValue.(filesListResult)
	if len(first.Entries) != 1 || !first.HasMore || first.NextOffset != 1 || first.DirectoryRevision == "" {
		t.Fatalf("unexpected first Files page: %#v", first)
	}
	secondValue, err := executeTest(request{
		ExpectedDirectoryRevision: first.DirectoryRevision,
		ExpectedRootIdentity:      &expected,
		Limit:                     1,
		Offset:                    first.NextOffset,
		Operation:                 "files-list",
		Root:                      workspace,
	})
	if err != nil {
		t.Fatal(err)
	}
	second := secondValue.(filesListResult)
	if len(second.Entries) != 1 || second.HasMore || second.NextOffset != 2 {
		t.Fatalf("unexpected second Files page: %#v", second)
	}

	encodedRaw := base64.RawURLEncoding.EncodeToString([]byte(rawName))
	readValue, err := executeTest(request{
		ExpectedRootIdentity: &expected,
		MaxBytes:             6,
		Operation:            "files-read-range",
		PathSegmentsBase64:   []string{encodedRaw},
		Root:                 workspace,
	})
	if err != nil {
		t.Fatal(err)
	}
	read := readValue.(filesReadRangeResult)
	content, err := base64.StdEncoding.DecodeString(read.ContentBase64)
	if err != nil || string(content) != "opaque" || read.EOF || read.Metadata.Revision == "" {
		t.Fatalf("unexpected Files range: %#v content=%q error=%v", read, content, err)
	}
	downloadValue, err := executeTest(request{
		ExpectedFileRevision: read.Metadata.Revision,
		ExpectedRootIdentity: &expected,
		Length:               7,
		Offset:               7,
		Operation:            "files-download",
		PathSegmentsBase64:   []string{encodedRaw},
		Root:                 workspace,
	})
	if err != nil {
		t.Fatal(err)
	}
	download := downloadValue.(*filesDownloadResult)
	defer download.file.Close()
	var streamed bytes.Buffer
	if err := writeFilesDownloadTo(&streamed, download); err != nil {
		t.Fatal(err)
	}
	framed := streamed.Bytes()
	newline := bytes.IndexByte(framed, '\n')
	if newline < 0 || string(framed[newline+1:]) != "content" {
		t.Fatalf("unexpected streamed Files frame: %q", framed)
	}

	if err := os.WriteFile(filepath.Join(workspace, "changed.txt"), []byte("changed"), 0600); err != nil {
		t.Fatal(err)
	}
	_, err = executeTest(request{
		ExpectedDirectoryRevision: first.DirectoryRevision,
		ExpectedRootIdentity:      &expected,
		Limit:                     1,
		Offset:                    1,
		Operation:                 "files-list",
		Root:                      workspace,
	})
	if !hasHelperCode(err, "concurrent-modification") {
		t.Fatalf("stale directory revision was accepted: %v", err)
	}

	wrong := expected
	wrong.FileID += "1"
	_, err = executeTest(request{
		ExpectedRootIdentity: &wrong,
		Limit:                1,
		Operation:            "files-list",
		Root:                 workspace,
	})
	if !hasHelperCode(err, "root-replaced") {
		t.Fatalf("wrong Workspace root identity was accepted: %v", err)
	}
}

func expectedRootIdentity(t *testing.T, workspace string) directoryIdentityResult {
	t.Helper()
	root, err := openWorkspaceRoot(workspace, false)
	if err != nil {
		t.Fatal(err)
	}
	defer root.close()
	handle, stat, err := root.openNode(nil)
	if err != nil {
		t.Fatal(err)
	}
	closeNode(handle)
	return directoryIdentityFromStat(stat)
}

func TestLargeDirectoryEnumerationStopsAtTheCallerBudget(t *testing.T) {
	workspace := t.TempDir()
	for index := 0; index < 4096; index++ {
		name := filepath.Join(workspace, fmt.Sprintf("entry-%05d.txt", 4095-index))
		if err := os.WriteFile(name, []byte("no match"), 0600); err != nil {
			t.Fatal(err)
		}
	}

	listed, err := executeTest(request{
		MaxDepth: 1, MaxEntries: 32, Operation: "list", Path: ".", Root: workspace,
	})
	if err != nil {
		t.Fatal(err)
	}
	list := listed.(listResult)
	if len(list.Entries) != 32 || !list.Truncated {
		t.Fatalf("large listing did not stop honestly at its budget: %#v", list)
	}
	listedPaths := make([]string, 0, len(list.Entries))
	for _, entry := range list.Entries {
		listedPaths = append(listedPaths, entry.Path)
	}
	if !sort.StringsAreSorted(listedPaths) {
		t.Fatalf("admitted directory window is not sorted: %#v", listedPaths)
	}

	searched, err := executeTest(request{
		CaseSensitive: true, MaxEntries: 32, MaxResults: 10, Operation: "search", Path: ".", Query: "absent", Root: workspace,
	})
	if err != nil {
		t.Fatal(err)
	}
	search := searched.(searchResult)
	if !search.Truncated || len(search.Matches) != 0 {
		t.Fatalf("large search did not stop honestly at its budget: %#v", search)
	}
}

func TestSearchCountsSkippedSymlinksAgainstTheTraversalBudget(t *testing.T) {
	workspace := t.TempDir()
	outside := t.TempDir()
	for index := 0; index < 100; index++ {
		if err := os.Symlink(outside, filepath.Join(workspace, fmt.Sprintf("link-%03d", index))); err != nil {
			t.Fatal(err)
		}
	}
	root, err := openWorkspaceRoot(workspace, false)
	if err != nil {
		t.Fatal(err)
	}
	defer root.close()
	fd, stat, err := root.openNode(nil)
	if err != nil {
		t.Fatal(err)
	}
	defer unix.Close(fd)
	state := searchState{
		caseSensitive: true,
		maxEntries:    10,
		maxResults:    10,
		query:         "absent",
		result:        searchResult{Matches: []searchMatch{}},
	}
	if err := visitSearch(root, fd, stat, ".", &state); err != nil {
		t.Fatal(err)
	}
	if state.visited != state.maxEntries || !state.result.Truncated {
		t.Fatalf("symlink entries escaped the traversal budget: visited=%d result=%#v", state.visited, state.result)
	}
}

func TestExactTraversalBudgetDoesNotTruncateEmptyDirectories(t *testing.T) {
	workspace := t.TempDir()
	if err := os.Mkdir(filepath.Join(workspace, "empty"), 0700); err != nil {
		t.Fatal(err)
	}
	listed, err := executeTest(request{
		MaxDepth: 2, MaxEntries: 1, Operation: "list", Path: ".", Root: workspace,
	})
	if err != nil {
		t.Fatal(err)
	}
	if result := listed.(listResult); len(result.Entries) != 1 || result.Truncated {
		t.Fatalf("exact listing of an empty child was marked truncated: %#v", result)
	}
	searched, err := executeTest(request{
		CaseSensitive: true, MaxEntries: 1, MaxResults: 10, Operation: "search", Path: "empty", Query: "absent", Root: workspace,
	})
	if err != nil {
		t.Fatal(err)
	}
	if result := searched.(searchResult); result.Truncated {
		t.Fatalf("exact search of an empty root was marked truncated: %#v", result)
	}
}

func TestProductionOperationsRequireAnIsolatedMountRoot(t *testing.T) {
	workspace := t.TempDir()
	if err := os.WriteFile(filepath.Join(workspace, "target.txt"), []byte("safe"), 0600); err != nil {
		t.Fatal(err)
	}
	requests := []request{
		{MaxDepth: 1, MaxEntries: 10, Operation: "list", Path: ".", Root: workspace},
		{Operation: "read", Path: "target.txt", Root: workspace},
		{CaseSensitive: true, MaxEntries: 10, MaxResults: 10, Operation: "search", Path: ".", Query: "safe", Root: workspace},
		{Content: "unsafe", Operation: "write", Path: "new.txt", Root: workspace},
		{NewText: "unsafe", OldText: "safe", Operation: "replace", Path: "target.txt", Root: workspace},
	}
	for _, input := range requests {
		input.RootPolicy = "isolated-mount"
		_, err := execute(input)
		var typed *helperError
		if !errors.As(err, &typed) || typed.code != "root-not-mount" {
			t.Fatalf("%s did not reject a same-device root: %v", input.Operation, err)
		}
	}
	content, err := os.ReadFile(filepath.Join(workspace, "target.txt"))
	if err != nil || string(content) != "safe" {
		t.Fatalf("rejected production operation mutated the root: %q, %v", content, err)
	}
	if _, err := os.Lstat(filepath.Join(workspace, "new.txt")); !os.IsNotExist(err) {
		t.Fatalf("rejected write created a file: %v", err)
	}
}

func TestMountBoundaryHasNoRequestLevelBypass(t *testing.T) {
	_, err := readRequest(strings.NewReader(`{"allowNonMountRootForTests":true,"operation":"read","path":"target.txt","root":"/tmp"}`))
	if err == nil || !strings.Contains(err.Error(), "unknown field") {
		t.Fatalf("request unexpectedly enabled the test root policy: %v", err)
	}
}

func TestEveryDescriptorAndListEntryEnforcesTheRootDevice(t *testing.T) {
	workspace := t.TempDir()
	if err := os.Mkdir(filepath.Join(workspace, "nested"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(workspace, "target.txt"), []byte("safe"), 0600); err != nil {
		t.Fatal(err)
	}
	root, err := openWorkspaceRoot(workspace, false)
	if err != nil {
		t.Fatal(err)
	}
	defer root.close()
	root.device++

	if _, _, err := root.openNodeAt(root.fd, "target.txt"); !hasHelperCode(err, "cross-device") {
		t.Fatalf("final-node open did not enforce root device: %v", err)
	}
	if _, err := root.openDirectoryAt(root.fd, "nested"); !hasHelperCode(err, "cross-device") {
		t.Fatalf("directory traversal did not enforce root device: %v", err)
	}
	result := listResult{Entries: []fileEntry{}}
	if err := visitList(root, root.fd, ".", 1, 1, 10, &result); !hasHelperCode(err, "cross-device") {
		t.Fatalf("final list entry did not enforce root device: %v", err)
	}
}

func hasHelperCode(err error, code string) bool {
	var typed *helperError
	return errors.As(err, &typed) && typed.code == code
}

func TestPinnedParentCannotBeRedirectedBySymlinkSwap(t *testing.T) {
	workspace := t.TempDir()
	outside := t.TempDir()
	raced := filepath.Join(workspace, "race")
	held := filepath.Join(workspace, "race-held")
	if err := os.Mkdir(raced, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(raced, "target.txt"), []byte("SAFE"), 0600); err != nil {
		t.Fatal(err)
	}
	outsideTarget := filepath.Join(outside, "target.txt")
	if err := os.WriteFile(outsideTarget, []byte("SECRET-RACE-WON"), 0600); err != nil {
		t.Fatal(err)
	}

	root, err := openWorkspaceRoot(workspace, false)
	if err != nil {
		t.Fatal(err)
	}
	defer root.close()
	parentFD, name, err := root.openParent([]string{"race", "target.txt"}, false)
	if err != nil {
		t.Fatal(err)
	}
	defer unix.Close(parentFD)
	if err := os.Rename(raced, held); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, raced); err != nil {
		t.Fatal(err)
	}

	fd, stat, err := root.openNodeAt(parentFD, name)
	if err != nil {
		t.Fatal(err)
	}
	content, err := readRegularFile(fd, stat)
	unix.Close(fd)
	if err != nil || string(content) != "SAFE" {
		t.Fatalf("pinned read escaped: %q, %v", content, err)
	}
	if _, err := root.atomicWrite(parentFD, name, []byte("UPDATED-SAFE"), nil); err != nil {
		t.Fatal(err)
	}
	outsideContent, err := os.ReadFile(outsideTarget)
	if err != nil || string(outsideContent) != "SECRET-RACE-WON" {
		t.Fatalf("pinned write escaped: %q, %v", outsideContent, err)
	}
	heldContent, err := os.ReadFile(filepath.Join(held, "target.txt"))
	if err != nil || string(heldContent) != "UPDATED-SAFE" {
		t.Fatalf("pinned write missed original directory: %q, %v", heldContent, err)
	}
}

func TestMutationsSerializeAndReplaceDetectsChangedIdentity(t *testing.T) {
	workspace := t.TempDir()
	if err := os.Mkdir(filepath.Join(workspace, "docs"), 0700); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(workspace, "docs", "target.txt")
	if err := os.WriteFile(target, []byte("before"), 0600); err != nil {
		t.Fatal(err)
	}
	root, err := openWorkspaceRoot(workspace, false)
	if err != nil {
		t.Fatal(err)
	}
	defer root.close()
	parentFD, name, err := root.openParent([]string{"docs", "target.txt"}, false)
	if err != nil {
		t.Fatal(err)
	}
	defer unix.Close(parentFD)
	if err := lockDirectory(parentFD); err != nil {
		t.Fatal(err)
	}
	completed := make(chan error, 1)
	go func() {
		_, err := executeTest(request{Content: "serialized", Operation: "write", Path: "docs/other.txt", Root: workspace})
		completed <- err
	}()
	select {
	case err := <-completed:
		t.Fatalf("mutation bypassed the directory lock: %v", err)
	case <-time.After(100 * time.Millisecond):
	}
	unlockDirectory(parentFD)
	select {
	case err := <-completed:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("serialized mutation did not resume")
	}

	fd, originalStat, err := root.openNodeAt(parentFD, name)
	if err != nil {
		t.Fatal(err)
	}
	unix.Close(fd)
	replacement := filepath.Join(workspace, "docs", "replacement.txt")
	if err := os.WriteFile(replacement, []byte("replacement"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(replacement, target); err != nil {
		t.Fatal(err)
	}
	expected := originalStat.identity
	_, err = root.atomicWrite(parentFD, name, []byte("must-not-win"), &expected)
	var typed *helperError
	if !errors.As(err, &typed) || typed.code != "concurrent-modification" {
		t.Fatalf("expected concurrent-modification, got %v", err)
	}
	content, err := os.ReadFile(target)
	if err != nil || string(content) != "replacement" {
		t.Fatalf("conflicting replace mutated target: %q, %v", content, err)
	}
}

func TestPostRenameFsyncFailureIsACommittedWarning(t *testing.T) {
	workspace := t.TempDir()
	target := filepath.Join(workspace, "target.txt")
	if err := os.WriteFile(target, []byte("before"), 0600); err != nil {
		t.Fatal(err)
	}
	root, err := openWorkspaceRoot(workspace, false)
	if err != nil {
		t.Fatal(err)
	}
	defer root.close()
	parentFD, name, err := root.openParent([]string{"target.txt"}, false)
	if err != nil {
		t.Fatal(err)
	}
	defer unix.Close(parentFD)
	originalFsyncDirectory := fsyncDirectory
	fsyncDirectory = func(int) error { return unix.EIO }
	t.Cleanup(func() { fsyncDirectory = originalFsyncDirectory })

	durability, err := root.atomicWrite(parentFD, name, []byte("after"), nil)
	if err != nil || durability != "sync-uncertain" {
		t.Fatalf("expected committed sync warning, got durability=%q error=%v", durability, err)
	}
	content, err := os.ReadFile(target)
	if err != nil || string(content) != "after" {
		t.Fatalf("rename did not commit before sync warning: %q, %v", content, err)
	}
}

func TestConcurrentSymlinkSwapsNeverEscapeAnyOperation(t *testing.T) {
	workspace := t.TempDir()
	outside := t.TempDir()
	raced := filepath.Join(workspace, "race")
	held := filepath.Join(workspace, "race-held")
	if err := os.Mkdir(raced, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(raced, "target.txt"), []byte("SAFE"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(outside, "target.txt"), []byte("SECRET-RACE-WON"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(outside, "outside-only.txt"), []byte("SECRET-RACE-WON"), 0600); err != nil {
		t.Fatal(err)
	}
	expected := expectedRootIdentity(t, workspace)
	raceSegments := []string{base64.RawURLEncoding.EncodeToString([]byte("race"))}
	targetSegments := append(append([]string{}, raceSegments...), base64.RawURLEncoding.EncodeToString([]byte("target.txt")))

	var stopped atomic.Bool
	done := make(chan struct{})
	go func() {
		defer close(done)
		for !stopped.Load() {
			if os.Rename(raced, held) != nil {
				continue
			}
			if os.Symlink(outside, raced) == nil {
				_ = os.Remove(raced)
			}
			_ = os.Rename(held, raced)
		}
	}()
	defer func() {
		stopped.Store(true)
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Fatal("race writer did not stop")
		}
	}()

	for index := 0; index < 2500; index++ {
		if value, err := executeTest(request{
			ExpectedRootIdentity: &expected,
			MaxBytes:             64,
			Operation:            "files-read-range",
			PathSegmentsBase64:   targetSegments,
			Root:                 workspace,
		}); err == nil {
			content, decodeErr := base64.StdEncoding.DecodeString(value.(filesReadRangeResult).ContentBase64)
			if decodeErr != nil || string(content) != "SAFE" {
				t.Fatalf("Files read escaped on iteration %d: %q, %v", index, content, decodeErr)
			}
		}
		if value, err := executeTest(request{
			ExpectedRootIdentity: &expected,
			Limit:                20,
			Operation:            "files-list",
			PathSegmentsBase64:   raceSegments,
			Root:                 workspace,
		}); err == nil {
			for _, entry := range value.(filesListResult).Entries {
				name, decodeErr := base64.RawURLEncoding.DecodeString(entry.NameBase64)
				if decodeErr != nil || string(name) == "outside-only.txt" {
					t.Fatalf("Files list escaped on iteration %d: %#v", index, value)
				}
			}
		}
		if value, err := executeTest(request{Operation: "read", Path: "race/target.txt", Root: workspace}); err == nil {
			content, decodeErr := base64.StdEncoding.DecodeString(value.(readResult).ContentBase64)
			if decodeErr != nil || string(content) != "SAFE" {
				t.Fatalf("read escaped on iteration %d: %q, %v", index, content, decodeErr)
			}
		}
		if value, err := executeTest(request{MaxDepth: 1, MaxEntries: 20, Operation: "list", Path: "race", Root: workspace}); err == nil {
			for _, entry := range value.(listResult).Entries {
				if strings.Contains(entry.Path, "outside-only") {
					t.Fatalf("list escaped on iteration %d: %#v", index, value)
				}
			}
		}
		if value, err := executeTest(request{CaseSensitive: true, MaxEntries: 20, MaxResults: 20, Operation: "search", Path: "race", Query: "SECRET-RACE-WON", Root: workspace}); err == nil && len(value.(searchResult).Matches) != 0 {
			t.Fatalf("search escaped on iteration %d: %#v", index, value)
		}
		_, _ = executeTest(request{Content: "SAFE-NEW", Operation: "write", Path: "race/new.txt", Root: workspace})
		_, _ = executeTest(request{NewText: "SAFE", OldText: "SAFE", Operation: "replace", Path: "race/target.txt", Root: workspace})
		if _, err := os.Lstat(filepath.Join(outside, "new.txt")); err == nil {
			t.Fatalf("write escaped on iteration %d", index)
		} else if !os.IsNotExist(err) {
			t.Fatal(err)
		}
		outsideContent, err := os.ReadFile(filepath.Join(outside, "target.txt"))
		if err != nil || string(outsideContent) != "SECRET-RACE-WON" {
			t.Fatalf("replace escaped on iteration %d: %q, %v", index, outsideContent, err)
		}
	}
}

func executeTest(input request) (any, error) {
	input.RootPolicy = "managed-local"
	return executeWithRootPolicy(input, true)
}
