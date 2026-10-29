package main

import (
	"bufio"
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"runtime"
	"sort"
	"strings"
	"unicode/utf8"
)

const (
	helperBinaryIdentity = "opensteer-native-fs"
	helperBinaryVersion  = "1.6.0"
	maxFileBytes         = 1024 * 1024
	maxRequestBytes      = 2 * 1024 * 1024
	maxSearchBytes       = 16 * 1024 * 1024
	maxResultBytes       = 400 * 1024
)

type request struct {
	CaseSensitive             bool                     `json:"caseSensitive,omitempty"`
	Content                   string                   `json:"content,omitempty"`
	ExpectedDirectoryRevision string                   `json:"expectedDirectoryRevision,omitempty"`
	ExpectedFileRevision      string                   `json:"expectedFileRevision,omitempty"`
	ExpectedRootIdentity      *directoryIdentityResult `json:"expectedRootIdentity,omitempty"`
	Length                    int64                    `json:"length,omitempty"`
	Limit                     int                      `json:"limit,omitempty"`
	MaxDepth                  int                      `json:"maxDepth,omitempty"`
	MaxBytes                  int                      `json:"maxBytes,omitempty"`
	MaxEntries                int                      `json:"maxEntries,omitempty"`
	MaxResults                int                      `json:"maxResults,omitempty"`
	NewText                   string                   `json:"newText,omitempty"`
	OldText                   string                   `json:"oldText,omitempty"`
	Operation                 string                   `json:"operation"`
	Offset                    int64                    `json:"offset,omitempty"`
	Path                      string                   `json:"path,omitempty"`
	PathSegmentsBase64        []string                 `json:"pathSegmentsBase64,omitempty"`
	Query                     string                   `json:"query,omitempty"`
	ReplaceAll                bool                     `json:"replaceAll,omitempty"`
	Resume                    bool                     `json:"resume,omitempty"`
	Root                      string                   `json:"root"`
	RootPolicy                string                   `json:"rootPolicy"`
}

type responseEnvelope struct {
	BinaryIdentity string         `json:"binaryIdentity"`
	BinaryVersion  string         `json:"binaryVersion"`
	Containment    string         `json:"containment"`
	Error          *responseError `json:"error,omitempty"`
	OK             bool           `json:"ok"`
	Platform       string         `json:"platform"`
	Result         any            `json:"result,omitempty"`
}

type responseError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type fileEntry struct {
	Path string `json:"path"`
	Size int64  `json:"size"`
	Type string `json:"type"`
}

type listResult struct {
	Entries   []fileEntry `json:"entries"`
	Truncated bool        `json:"truncated"`
}

type readResult struct {
	ContentBase64 string `json:"contentBase64"`
	Path          string `json:"path"`
	Size          int    `json:"size"`
}

type searchMatch struct {
	Line int    `json:"line"`
	Path string `json:"path"`
	Text string `json:"text"`
}

type searchResult struct {
	Matches      []searchMatch `json:"matches"`
	ScannedBytes int           `json:"scannedBytes"`
	Truncated    bool          `json:"truncated"`
}

type writeResult struct {
	BytesWritten int    `json:"bytesWritten"`
	Durability   string `json:"durability"`
	Path         string `json:"path"`
}

type replaceResult struct {
	Durability          string `json:"durability"`
	OccurrencesReplaced int    `json:"occurrencesReplaced"`
	Path                string `json:"path"`
}

type directoryIdentityResult struct {
	FileID   string `json:"fileId"`
	Kind     string `json:"kind"`
	VolumeID string `json:"volumeId"`
}

type ensureRootResult struct {
	Created  bool                    `json:"created"`
	Identity directoryIdentityResult `json:"identity"`
}

type fileIdentity struct {
	fileID   string
	volumeID string
}

type nodeStat struct {
	changedUnixNano  int64
	identity         fileIdentity
	kind             string
	mode             uint32
	modifiedUnixNano int64
	size             int64
}

func main() {
	if len(os.Args) == 2 && os.Args[1] == "--runtime-pidfd-signal-probe" {
		if err := runtimePidfdSignalProbe(); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}
	if len(os.Args) >= 2 {
		switch os.Args[1] {
		case "shell-keygen":
			if err := runShellKeygen(os.Args[2:], os.Stdout); err != nil {
				fmt.Fprintln(os.Stderr, err)
				os.Exit(1)
			}
			return
		case "full-disk-access":
			if err := runFullDiskAccess(os.Args[2:], os.Stdout); err != nil {
				fmt.Fprintln(os.Stderr, err)
				os.Exit(1)
			}
			return
		case "ssh-proxy":
			os.Exit(runSSHProxy(os.Args[2:], os.Stdin, os.Stdout, os.Stderr))
		case "shell-serve":
			if len(os.Args) != 2 {
				fmt.Fprintln(os.Stderr, "usage: opensteer-native-fs shell-serve")
				os.Exit(1)
			}
			if err := runShellServe(os.Stdin, os.Stdout); err != nil {
				fmt.Fprintln(os.Stderr, err)
				os.Exit(1)
			}
			return
		}
	}
	value, err := readRequest(os.Stdin)
	if err != nil {
		writeResponse(responseEnvelope{
			Error: &responseError{Code: "invalid-request", Message: "Native filesystem helper request is invalid"},
			OK:    false,
		})
		return
	}
	result, err := execute(value)
	if err != nil {
		code, message := publicError(err)
		writeResponse(responseEnvelope{
			Error: &responseError{Code: code, Message: message},
			OK:    false,
		})
		return
	}
	if download, ok := result.(*filesDownloadResult); ok {
		if err := writeFilesDownload(download); err != nil {
			_ = download.file.Close()
			os.Exit(1)
		}
		_ = download.file.Close()
		return
	}
	writeResponse(responseEnvelope{OK: true, Result: result})
}

func readRequest(reader io.Reader) (request, error) {
	limited := &io.LimitedReader{R: reader, N: maxRequestBytes + 1}
	content, err := io.ReadAll(limited)
	if err != nil || len(content) > maxRequestBytes {
		return request{}, errors.New("request exceeds its byte limit")
	}
	decoder := json.NewDecoder(bytes.NewReader(content))
	decoder.DisallowUnknownFields()
	var value request
	if err := decoder.Decode(&value); err != nil {
		return request{}, err
	}
	if decoder.Decode(&struct{}{}) != io.EOF {
		return request{}, errors.New("request contains trailing data")
	}
	return value, nil
}

func writeResponse(value responseEnvelope) {
	value.BinaryIdentity = helperBinaryIdentity
	value.BinaryVersion = helperBinaryVersion
	value.Containment = platformContainment
	value.Platform = runtime.GOOS
	writer := bufio.NewWriterSize(os.Stdout, 64*1024)
	_ = json.NewEncoder(writer).Encode(value)
	_ = writer.Flush()
}

func execute(input request) (any, error) {
	return executeWithRootPolicy(input, allowNonMountRootsForTests == "true")
}

// Set only by the separately named test-helper build. The production and
// container binaries contain no request-level bypass for the mount boundary.
var allowNonMountRootsForTests = "false"

func executeWithRootPolicy(input request, allowNonMountRoot bool) (any, error) {
	requireMountBoundary := false
	switch input.RootPolicy {
	case "isolated-mount":
		requireMountBoundary = input.Operation != "probe" && !allowNonMountRoot
	case "managed-local":
		// The Host and protected local Workspace registry authorize the exact
		// root. This helper still enforces descriptor-relative traversal,
		// no-follow semantics, and same-device containment inside that root.
	case "desktop-private":
		return executeDesktopPrivate(input)
	default:
		return nil, userError("invalid-root-policy", "Native filesystem root policy is invalid")
	}
	if input.Operation == "ensure-root" {
		if input.RootPolicy != "managed-local" {
			return nil, userError("invalid-root-policy", "Only a managed-local authority may create a Workspace root")
		}
		return ensureWorkspaceRoot(input.Root)
	}
	root, err := openWorkspaceRoot(input.Root, requireMountBoundary)
	if err != nil {
		return nil, err
	}
	defer root.close()

	switch input.Operation {
	case "probe":
		if err := root.probe(); err != nil {
			return nil, err
		}
		return map[string]any{
			"binaryIdentity": helperBinaryIdentity,
			"binaryVersion":  helperBinaryVersion,
			"containment":    root.containment,
			"platform":       runtime.GOOS,
		}, nil
	case "directory-identity":
		return executeDirectoryIdentity(root, input)
	case "ensure-directory":
		return executeEnsureDirectory(root, input)
	case "list":
		return executeList(root, input)
	case "read":
		return executeRead(root, input)
	case "search":
		return executeSearch(root, input)
	case "write":
		return executeWrite(root, input)
	case "replace":
		return executeReplace(root, input)
	case "files-list":
		return executeFilesList(root, input)
	case "files-read-range":
		return executeFilesReadRange(root, input)
	case "files-download":
		return executeFilesDownload(root, input)
	default:
		return nil, userError("invalid-operation", "Native filesystem helper operation is invalid")
	}
}

func executeEnsureDirectory(root *workspaceRoot, input request) (directoryIdentityResult, error) {
	parts, _, err := relativeParts(input.Path, false)
	if err != nil {
		return directoryIdentityResult{}, err
	}
	parent, name, err := root.openParent(parts, true)
	if err != nil {
		return directoryIdentityResult{}, err
	}
	defer closeNode(parent)
	if err := lockDirectory(parent); err != nil {
		return directoryIdentityResult{}, err
	}
	defer unlockDirectory(parent)
	handle, stat, err := root.createDirectoryAt(parent, name)
	if err != nil && input.Resume && isAlreadyExists(err) {
		handle, err = root.openDirectoryAt(parent, name)
		if err == nil {
			// Derive the resumed directory identity from the handle we will
			// return, rather than reopening the name and leaving a replacement
			// race between validation and identity capture.
			stat, err = statNodeHandle(handle)
		}
	}
	if err != nil {
		if isAlreadyExists(err) {
			return directoryIdentityResult{}, userError("already-exists", "Managed Workspace directory already exists")
		}
		return directoryIdentityResult{}, err
	}
	defer closeNode(handle)
	return directoryIdentityFromStat(stat), nil
}

func executeDirectoryIdentity(root *workspaceRoot, input request) (directoryIdentityResult, error) {
	parts, _, err := relativeParts(input.Path, true)
	if err != nil {
		return directoryIdentityResult{}, err
	}
	handle, stat, err := root.openNode(parts)
	if err != nil {
		return directoryIdentityResult{}, err
	}
	defer closeNode(handle)
	if stat.kind != "directory" {
		return directoryIdentityResult{}, userError("not-directory", "Directory identity path must be a directory")
	}
	return directoryIdentityFromStat(stat), nil
}

func executeList(root *workspaceRoot, input request) (listResult, error) {
	if input.MaxDepth < 1 || input.MaxDepth > 5 || input.MaxEntries < 1 || input.MaxEntries > 2000 {
		return listResult{}, userError("invalid-request", "Native filesystem list bounds are invalid")
	}
	parts, display, err := relativeParts(input.Path, true)
	if err != nil {
		return listResult{}, err
	}
	fd, stat, err := root.openNode(parts)
	if err != nil {
		return listResult{}, err
	}
	defer closeNode(fd)
	if stat.kind != "directory" {
		return listResult{}, userError("not-directory", "list_files path must be a directory")
	}
	result := listResult{Entries: []fileEntry{}}
	if err := visitList(root, fd, display, 1, input.MaxDepth, input.MaxEntries, &result); err != nil {
		return listResult{}, err
	}
	return result, nil
}

func visitList(
	root *workspaceRoot,
	directoryFD nodeHandle,
	prefix string,
	depth int,
	maxDepth int,
	maxEntries int,
	result *listResult,
) error {
	remaining := maxEntries - len(result.Entries)
	if remaining <= 0 {
		hasEntries, err := directoryHasEntries(directoryFD)
		if err != nil {
			return err
		}
		result.Truncated = hasEntries
		return nil
	}
	entries, directoryTruncated, err := readDirectory(directoryFD, remaining)
	if err != nil {
		return err
	}
	for _, child := range entries {
		if len(result.Entries) >= maxEntries {
			result.Truncated = true
			return nil
		}
		stat, err := root.statNodeAt(directoryFD, child)
		if err != nil {
			return err
		}
		entry := fileEntry{
			Path: joinDisplay(prefix, child),
			Size: stat.size,
			Type: stat.kind,
		}
		candidate := listResult{Entries: appendCopy(result.Entries, entry), Truncated: false}
		if !fitsResult(candidate) {
			result.Truncated = true
			return nil
		}
		result.Entries = append(result.Entries, entry)
		if entry.Type == "directory" && depth < maxDepth {
			childFD, err := root.openDirectoryAt(directoryFD, child)
			if err != nil {
				return err
			}
			err = visitList(root, childFD, entry.Path, depth+1, maxDepth, maxEntries, result)
			closeNode(childFD)
			if err != nil || result.Truncated {
				return err
			}
		}
	}
	if directoryTruncated {
		result.Truncated = true
	}
	return nil
}

func executeRead(root *workspaceRoot, input request) (readResult, error) {
	parts, display, err := relativeParts(input.Path, false)
	if err != nil {
		return readResult{}, err
	}
	fd, stat, err := root.openNode(parts)
	if err != nil {
		return readResult{}, err
	}
	defer closeNode(fd)
	content, err := readRegularFile(fd, stat)
	if err != nil {
		return readResult{}, err
	}
	return readResult{
		ContentBase64: base64.StdEncoding.EncodeToString(content),
		Path:          display,
		Size:          len(content),
	}, nil
}

func executeSearch(root *workspaceRoot, input request) (searchResult, error) {
	if input.MaxEntries < 1 || input.MaxEntries > 20000 || input.MaxResults < 1 || input.MaxResults > 500 || input.Query == "" || len(input.Query) > 2000 {
		return searchResult{}, userError("invalid-request", "Native filesystem search bounds are invalid")
	}
	parts, display, err := relativeParts(input.Path, true)
	if err != nil {
		return searchResult{}, err
	}
	fd, stat, err := root.openNode(parts)
	if err != nil {
		return searchResult{}, err
	}
	defer closeNode(fd)
	state := searchState{
		caseSensitive: input.CaseSensitive,
		maxEntries:    input.MaxEntries,
		maxResults:    input.MaxResults,
		query:         input.Query,
		result:        searchResult{Matches: []searchMatch{}},
	}
	if !state.caseSensitive {
		state.query = strings.ToLower(state.query)
	}
	if err := visitSearch(root, fd, stat, display, &state); err != nil {
		return searchResult{}, err
	}
	return state.result, nil
}

type searchState struct {
	caseSensitive bool
	maxEntries    int
	maxResults    int
	query         string
	result        searchResult
	visited       int
}

func visitSearch(root *workspaceRoot, fd nodeHandle, stat nodeStat, display string, state *searchState) error {
	if state.visited >= state.maxEntries {
		state.result.Truncated = true
		return nil
	}
	state.visited++
	switch stat.kind {
	case "file":
		return scanSearchFile(fd, stat, display, state)
	case "directory":
		remaining := state.maxEntries - state.visited
		if remaining <= 0 {
			hasEntries, err := directoryHasEntries(fd)
			if err != nil {
				return err
			}
			state.result.Truncated = hasEntries
			return nil
		}
		entries, directoryTruncated, err := readDirectory(fd, remaining)
		if err != nil {
			return err
		}
		for _, child := range entries {
			if state.result.Truncated {
				return nil
			}
			if state.visited >= state.maxEntries {
				state.result.Truncated = true
				return nil
			}
			childStat, err := root.statNodeAt(fd, child)
			if err != nil {
				return err
			}
			if childStat.kind == "symlink" {
				state.visited++
				continue
			}
			childFD, openedStat, err := root.openNodeAt(fd, child)
			if err != nil {
				return err
			}
			err = visitSearch(root, childFD, openedStat, joinDisplay(display, child), state)
			closeNode(childFD)
			if err != nil {
				return err
			}
		}
		if directoryTruncated {
			state.result.Truncated = true
		}
	}
	return nil
}

func scanSearchFile(fd nodeHandle, stat nodeStat, display string, state *searchState) error {
	if stat.size > maxFileBytes {
		return nil
	}
	if stat.size < 0 || state.result.ScannedBytes+int(stat.size) > maxSearchBytes {
		state.result.Truncated = true
		return nil
	}
	content, err := readRegularFile(fd, stat)
	if err != nil {
		var typed *helperError
		if errors.As(err, &typed) && (typed.code == "binary-file" || typed.code == "file-too-large") {
			return nil
		}
		return err
	}
	if state.result.ScannedBytes+len(content) > maxSearchBytes {
		state.result.Truncated = true
		return nil
	}
	state.result.ScannedBytes += len(content)
	if bytes.IndexByte(content, 0) >= 0 || !utf8.Valid(content) {
		return nil
	}
	for index, line := range strings.Split(strings.ReplaceAll(string(content), "\r\n", "\n"), "\n") {
		candidate := line
		if !state.caseSensitive {
			candidate = strings.ToLower(candidate)
		}
		if !strings.Contains(candidate, state.query) {
			continue
		}
		match := searchMatch{Line: index + 1, Path: display, Text: truncateRunes(line, 2000)}
		proposed := searchResult{
			Matches:      appendCopy(state.result.Matches, match),
			ScannedBytes: state.result.ScannedBytes,
			Truncated:    false,
		}
		if !fitsResult(proposed) {
			state.result.Truncated = true
			return nil
		}
		state.result.Matches = append(state.result.Matches, match)
		if len(state.result.Matches) >= state.maxResults {
			state.result.Truncated = true
			return nil
		}
	}
	return nil
}

func executeWrite(root *workspaceRoot, input request) (writeResult, error) {
	parts, display, err := relativeParts(input.Path, false)
	if err != nil {
		return writeResult{}, err
	}
	content := []byte(input.Content)
	if len(content) > maxFileBytes {
		return writeResult{}, userError("file-too-large", "Text file exceeds the 1 MiB limit")
	}
	parentFD, name, err := root.openParent(parts, true)
	if err != nil {
		return writeResult{}, err
	}
	defer closeNode(parentFD)
	if err := lockDirectory(parentFD); err != nil {
		return writeResult{}, err
	}
	defer unlockDirectory(parentFD)
	durability, err := root.atomicWrite(parentFD, name, content, nil)
	if err != nil {
		return writeResult{}, err
	}
	return writeResult{BytesWritten: len(content), Durability: durability, Path: display}, nil
}

func executeReplace(root *workspaceRoot, input request) (replaceResult, error) {
	if input.OldText == "" {
		return replaceResult{}, userError("invalid-request", "The replacement source text is empty")
	}
	parts, display, err := relativeParts(input.Path, false)
	if err != nil {
		return replaceResult{}, err
	}
	parentFD, name, err := root.openParent(parts, false)
	if err != nil {
		return replaceResult{}, err
	}
	defer closeNode(parentFD)
	if err := lockDirectory(parentFD); err != nil {
		return replaceResult{}, err
	}
	defer unlockDirectory(parentFD)
	fd, stat, err := root.openNodeAt(parentFD, name)
	if err != nil {
		return replaceResult{}, err
	}
	content, err := readRegularFile(fd, stat)
	closeNode(fd)
	if err != nil {
		return replaceResult{}, err
	}
	if bytes.IndexByte(content, 0) >= 0 || !utf8.Valid(content) {
		return replaceResult{}, userError("binary-file", "File appears to be binary or is not valid UTF-8")
	}
	original := string(content)
	occurrences := strings.Count(original, input.OldText)
	if occurrences == 0 {
		return replaceResult{}, userError("not-found", "The requested text was not found")
	}
	if !input.ReplaceAll && occurrences != 1 {
		return replaceResult{}, userError("ambiguous", fmt.Sprintf("The requested text occurs %d times; use replaceAll or provide more context", occurrences))
	}
	replacements := 1
	if input.ReplaceAll {
		replacements = occurrences
	}
	updated := strings.Replace(original, input.OldText, input.NewText, replacements)
	if len(updated) > maxFileBytes {
		return replaceResult{}, userError("file-too-large", "Updated text file exceeds the 1 MiB limit")
	}
	expected := stat.identity
	durability, err := root.atomicWrite(parentFD, name, []byte(updated), &expected)
	if err != nil {
		return replaceResult{}, err
	}
	return replaceResult{Durability: durability, OccurrencesReplaced: replacements, Path: display}, nil
}

func readRegularFile(fd nodeHandle, stat nodeStat) ([]byte, error) {
	if stat.kind != "file" {
		return nil, userError("not-regular", "Path must name a regular file")
	}
	if stat.size > maxFileBytes {
		return nil, userError("file-too-large", "Text file exceeds the 1 MiB limit")
	}
	file, err := duplicateNodeFile(fd, "workspace-file")
	if err != nil {
		return nil, err
	}
	defer file.Close()
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		return nil, err
	}
	content, err := io.ReadAll(io.LimitReader(file, maxFileBytes+1))
	if err != nil {
		return nil, err
	}
	if len(content) > maxFileBytes {
		return nil, userError("file-too-large", "Text file exceeds the 1 MiB limit")
	}
	return content, nil
}

func readDirectory(fd nodeHandle, maximum int) ([]string, bool, error) {
	if maximum < 1 || maximum > 20000 {
		return nil, false, userError("invalid-request", "Native filesystem directory bound is invalid")
	}
	file, err := duplicateNodeFile(fd, "workspace-directory")
	if err != nil {
		return nil, false, err
	}
	// Read at most one entry beyond the caller's remaining traversal budget.
	// This preserves deterministic sorting within the admitted window without
	// allocating an entire million-inode Workspace directory first.
	entries, err := file.ReadDir(maximum + 1)
	_ = file.Close()
	if err != nil && !errors.Is(err, io.EOF) {
		return nil, false, err
	}
	truncated := len(entries) > maximum
	if truncated {
		entries = entries[:maximum]
	}
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		names = append(names, entry.Name())
	}
	sort.Strings(names)
	return names, truncated, nil
}

func directoryHasEntries(fd nodeHandle) (bool, error) {
	entries, _, err := readDirectory(fd, 1)
	return len(entries) != 0, err
}

func fitsResult(value any) bool {
	encoded, err := json.Marshal(value)
	return err == nil && len(encoded) <= maxResultBytes
}

func joinDisplay(parent string, child string) string {
	if parent == "." {
		return child
	}
	return parent + "/" + child
}

func appendCopy[T any](values []T, value T) []T {
	copyOf := make([]T, len(values), len(values)+1)
	copy(copyOf, values)
	return append(copyOf, value)
}

func truncateRunes(value string, maximum int) string {
	runes := []rune(value)
	if len(runes) <= maximum {
		return value
	}
	return string(runes[:maximum])
}

type helperError struct {
	code    string
	message string
}

func (value *helperError) Error() string { return value.message }

func userError(code string, message string) error {
	return &helperError{code: code, message: message}
}

func publicError(err error) (string, string) {
	var typed *helperError
	if errors.As(err, &typed) {
		return typed.code, typed.message
	}
	if code, message, ok := platformPublicError(err); ok {
		return code, message
	}
	return "filesystem-error", "Native filesystem operation failed"
}
