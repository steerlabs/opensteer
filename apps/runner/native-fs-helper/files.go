package main

import (
	"bufio"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"runtime"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

const (
	maxFilesDirectoryOffset = 1_000_000
	maxFilesPageEntries     = 500
	maxFilesPreviewBytes    = 512 * 1024
	maxJavaScriptSafeInt    = int64(9_007_199_254_740_991)
	filesReadBatchEntries   = 256
)

type filesEntry struct {
	Executable  bool    `json:"executable"`
	DisplayName string  `json:"displayName"`
	Hidden      bool    `json:"hidden"`
	Kind        string  `json:"kind"`
	Mode        uint32  `json:"mode"`
	ModifiedAt  *string `json:"modifiedAt"`
	NameBase64  string  `json:"nameBase64"`
	SizeBytes   int64   `json:"sizeBytes"`
}

type filesListResult struct {
	DirectoryRevision string       `json:"directoryRevision"`
	Entries           []filesEntry `json:"entries"`
	HasMore           bool         `json:"hasMore"`
	NextOffset        int64        `json:"nextOffset"`
}

type filesMetadata struct {
	ModifiedAt *string `json:"modifiedAt"`
	Mode       uint32  `json:"mode"`
	Revision   string  `json:"revision"`
	SizeBytes  int64   `json:"sizeBytes"`
}

type filesReadRangeResult struct {
	BytesRead     int           `json:"bytesRead"`
	ContentBase64 string        `json:"contentBase64"`
	EOF           bool          `json:"eof"`
	Metadata      filesMetadata `json:"metadata"`
	Offset        int64         `json:"offset"`
}

type filesDownloadMetadata struct {
	Length   int64         `json:"length"`
	Metadata filesMetadata `json:"metadata"`
	Offset   int64         `json:"offset"`
}

type filesDownloadResult struct {
	expectedRevision string
	file             *os.File
	metadata         filesDownloadMetadata
}

func executeFilesList(root *workspaceRoot, input request) (filesListResult, error) {
	if input.Offset < 0 || input.Offset > maxFilesDirectoryOffset || input.Limit < 1 || input.Limit > maxFilesPageEntries {
		return filesListResult{}, userError("invalid-request", "Files directory page bounds are invalid")
	}
	if err := assertExpectedFilesRoot(root, input.ExpectedRootIdentity); err != nil {
		return filesListResult{}, err
	}
	parts, err := filesRelativeParts(input.PathSegmentsBase64, true)
	if err != nil {
		return filesListResult{}, err
	}
	directory, before, err := root.openNode(parts)
	if err != nil {
		return filesListResult{}, err
	}
	defer closeNode(directory)
	if before.kind != "directory" {
		return filesListResult{}, userError("not-directory", "Files key must name a directory")
	}
	revision := nodeRevision(before)
	if input.ExpectedDirectoryRevision != "" && input.ExpectedDirectoryRevision != revision {
		return filesListResult{}, userError("concurrent-modification", "Workspace directory changed between pages")
	}
	file, err := duplicateNodeFile(directory, "workspace-files-directory")
	if err != nil {
		return filesListResult{}, err
	}
	defer file.Close()

	result := filesListResult{
		DirectoryRevision: revision,
		Entries:           make([]filesEntry, 0, input.Limit),
		NextOffset:        input.Offset,
	}
	var visited int64
	for {
		batch, readErr := file.ReadDir(filesReadBatchEntries)
		if readErr != nil && !errors.Is(readErr, io.EOF) {
			return filesListResult{}, readErr
		}
		for _, candidate := range batch {
			if visited < input.Offset {
				visited++
				continue
			}
			if len(result.Entries) >= input.Limit {
				result.HasMore = true
				break
			}
			name := candidate.Name()
			stat, statErr := root.statNodeAt(directory, name)
			if statErr != nil {
				return filesListResult{}, userError("concurrent-modification", "Workspace directory changed while it was being listed")
			}
			result.Entries = append(result.Entries, filesEntryFromStat(name, stat))
			visited++
			result.NextOffset = visited
		}
		if result.HasMore || errors.Is(readErr, io.EOF) {
			break
		}
	}
	after, err := statNodeHandle(directory)
	if err != nil {
		return filesListResult{}, err
	}
	if nodeRevision(after) != revision {
		return filesListResult{}, userError("concurrent-modification", "Workspace directory changed while it was being listed")
	}
	return result, nil
}

func executeFilesReadRange(root *workspaceRoot, input request) (filesReadRangeResult, error) {
	if input.Offset < 0 || input.Offset > maxJavaScriptSafeInt || input.MaxBytes < 1 || input.MaxBytes > maxFilesPreviewBytes {
		return filesReadRangeResult{}, userError("invalid-request", "Files read range is invalid")
	}
	if err := assertExpectedFilesRoot(root, input.ExpectedRootIdentity); err != nil {
		return filesReadRangeResult{}, err
	}
	parts, err := filesRelativeParts(input.PathSegmentsBase64, false)
	if err != nil {
		return filesReadRangeResult{}, err
	}
	handle, before, err := root.openNode(parts)
	if err != nil {
		return filesReadRangeResult{}, err
	}
	defer closeNode(handle)
	if before.kind != "file" {
		return filesReadRangeResult{}, userError("not-regular", "Files key must name a regular file")
	}
	if before.size < 0 || before.size > maxJavaScriptSafeInt || input.Offset > before.size {
		return filesReadRangeResult{}, userError("invalid-request", "Workspace file range is outside the supported bounds")
	}
	revision := nodeRevision(before)
	if input.ExpectedFileRevision != "" && input.ExpectedFileRevision != revision {
		return filesReadRangeResult{}, userError("concurrent-modification", "Workspace file changed between reads")
	}
	file, err := duplicateNodeFile(handle, "workspace-files-preview")
	if err != nil {
		return filesReadRangeResult{}, err
	}
	defer file.Close()
	maximum := int64(input.MaxBytes)
	if remaining := before.size - input.Offset; remaining < maximum {
		maximum = remaining
	}
	content := make([]byte, int(maximum))
	read := 0
	for read < len(content) {
		count, readErr := file.ReadAt(content[read:], input.Offset+int64(read))
		read += count
		if errors.Is(readErr, io.EOF) {
			break
		}
		if readErr != nil {
			return filesReadRangeResult{}, readErr
		}
		if count == 0 {
			break
		}
	}
	content = content[:read]
	after, err := statNodeHandle(handle)
	if err != nil {
		return filesReadRangeResult{}, err
	}
	if nodeRevision(after) != revision {
		return filesReadRangeResult{}, userError("concurrent-modification", "Workspace file changed while it was being read")
	}
	return filesReadRangeResult{
		BytesRead:     len(content),
		ContentBase64: base64.StdEncoding.EncodeToString(content),
		EOF:           input.Offset+int64(len(content)) >= before.size,
		Metadata:      filesMetadataFromStat(before),
		Offset:        input.Offset,
	}, nil
}

func executeFilesDownload(root *workspaceRoot, input request) (*filesDownloadResult, error) {
	if input.Offset < 0 || input.Offset > maxJavaScriptSafeInt || input.Length < 0 || input.Length > maxJavaScriptSafeInt {
		return nil, userError("invalid-request", "Files download range is invalid")
	}
	if err := assertExpectedFilesRoot(root, input.ExpectedRootIdentity); err != nil {
		return nil, err
	}
	parts, err := filesRelativeParts(input.PathSegmentsBase64, false)
	if err != nil {
		return nil, err
	}
	handle, stat, err := root.openNode(parts)
	if err != nil {
		return nil, err
	}
	defer closeNode(handle)
	if stat.kind != "file" {
		return nil, userError("not-regular", "Files key must name a regular file")
	}
	if stat.size < 0 || stat.size > maxJavaScriptSafeInt || input.Offset > stat.size {
		return nil, userError("invalid-request", "Workspace file is outside the supported size bounds")
	}
	revision := nodeRevision(stat)
	if input.ExpectedFileRevision != "" && input.ExpectedFileRevision != revision {
		return nil, userError("concurrent-modification", "Workspace file changed before download")
	}
	length := input.Length
	if length == 0 && input.Offset == 0 {
		length = stat.size - input.Offset
	}
	if length > stat.size-input.Offset {
		return nil, userError("invalid-request", "Files download range exceeds the file")
	}
	file, err := duplicateNodeFile(handle, "workspace-files-download")
	if err != nil {
		return nil, err
	}
	if _, err := file.Seek(input.Offset, io.SeekStart); err != nil {
		file.Close()
		return nil, err
	}
	return &filesDownloadResult{
		expectedRevision: revision,
		file:             file,
		metadata: filesDownloadMetadata{
			Length:   length,
			Metadata: filesMetadataFromStat(stat),
			Offset:   input.Offset,
		},
	}, nil
}

func writeFilesDownload(download *filesDownloadResult) error {
	return writeFilesDownloadTo(os.Stdout, download)
}

func writeFilesDownloadTo(output io.Writer, download *filesDownloadResult) error {
	envelope := responseEnvelope{OK: true, Result: download.metadata}
	envelope.BinaryIdentity = helperBinaryIdentity
	envelope.BinaryVersion = helperBinaryVersion
	envelope.Containment = platformContainment
	envelope.Platform = runtime.GOOS
	writer := bufio.NewWriterSize(output, 64*1024)
	if err := json.NewEncoder(writer).Encode(envelope); err != nil {
		return err
	}
	if err := writer.Flush(); err != nil {
		return err
	}
	written, err := io.CopyN(output, download.file, download.metadata.Length)
	if err != nil {
		return err
	}
	if written != download.metadata.Length {
		return io.ErrUnexpectedEOF
	}
	after, err := statOpenFile(download.file)
	if err != nil {
		return err
	}
	if nodeRevision(after) != download.expectedRevision {
		return userError("concurrent-modification", "Workspace file changed while it was being downloaded")
	}
	return nil
}

func assertExpectedFilesRoot(root *workspaceRoot, expected *directoryIdentityResult) error {
	if expected == nil {
		return userError("invalid-request", "Files operation requires an expected Workspace root identity")
	}
	if !validExpectedRootIdentity(*expected) {
		return userError("invalid-request", "Files operation expected Workspace root identity is invalid")
	}
	handle, stat, err := root.openNode(nil)
	if err != nil {
		return err
	}
	closeNode(handle)
	actual := directoryIdentityFromStat(stat)
	if stat.kind != "directory" || actual != *expected {
		return userError("root-replaced", "Managed Workspace directory identity no longer matches its binding")
	}
	return nil
}

func validExpectedRootIdentity(identity directoryIdentityResult) bool {
	if identity.Kind != "posix" && identity.Kind != "windows" {
		return false
	}
	if identity.VolumeID == "" {
		return false
	}
	for _, character := range identity.VolumeID {
		if character < '0' || character > '9' {
			return false
		}
	}
	if identity.Kind == "windows" {
		return len(identity.FileID) == 32 && canonicalFileID(identity.FileID)
	}
	if identity.FileID == "" {
		return false
	}
	for _, character := range identity.FileID {
		if character < '0' || character > '9' {
			return false
		}
	}
	return true
}

func filesRelativeParts(encoded []string, allowRoot bool) ([]string, error) {
	if len(encoded) == 0 {
		if allowRoot {
			return nil, nil
		}
		return nil, userError("invalid-path", "Files key must name an entry")
	}
	if len(encoded) > 256 {
		return nil, userError("invalid-path", "Files key contains too many path components")
	}
	parts := make([]string, 0, len(encoded))
	total := 0
	for _, value := range encoded {
		decoded, err := base64.RawURLEncoding.DecodeString(value)
		if err != nil || base64.RawURLEncoding.EncodeToString(decoded) != value {
			return nil, userError("invalid-path", "Files key contains an invalid path component")
		}
		total += len(decoded)
		if total > 4096 {
			return nil, userError("invalid-path", "Files key exceeds its byte limit")
		}
		part, err := nativeFilesComponent(decoded)
		if err != nil {
			return nil, err
		}
		parts = append(parts, part)
	}
	return parts, nil
}

func filesEntryFromStat(name string, stat nodeStat) filesEntry {
	kind := stat.kind
	if kind == "other" {
		kind = "opaque"
	}
	nameBytes := []byte(name)
	return filesEntry{
		Executable:  (stat.mode & 0o111) != 0,
		DisplayName: filesDisplayName(nameBytes),
		Hidden:      len(nameBytes) > 0 && nameBytes[0] == '.',
		Kind:        kind,
		Mode:        stat.mode & 0o7777,
		ModifiedAt:  safeModifiedAt(stat.modifiedUnixNano),
		NameBase64:  base64.RawURLEncoding.EncodeToString(nameBytes),
		SizeBytes:   max(stat.size, 0),
	}
}

func filesDisplayName(value []byte) string {
	var builder strings.Builder
	remaining := value
	for len(remaining) > 0 {
		r, size := utf8.DecodeRune(remaining)
		if r == utf8.RuneError && size == 1 {
			_, _ = fmt.Fprintf(&builder, "\\x%02X", remaining[0])
			remaining = remaining[1:]
			continue
		}
		if r == '\\' {
			builder.WriteString("\\\\")
		} else if unicode.IsControl(r) || unicode.In(r, unicode.Cf) {
			for _, octet := range remaining[:size] {
				_, _ = fmt.Fprintf(&builder, "\\x%02X", octet)
			}
		} else {
			builder.Write(remaining[:size])
		}
		remaining = remaining[size:]
	}
	display := builder.String()
	if strings.HasPrefix(display, "~") {
		display = "~" + display
	}
	if len(display) <= 1024 {
		return display
	}
	return "~" + base64.RawURLEncoding.EncodeToString(value)
}

func filesMetadataFromStat(stat nodeStat) filesMetadata {
	return filesMetadata{
		ModifiedAt: safeModifiedAt(stat.modifiedUnixNano),
		Mode:       stat.mode & 0o7777,
		Revision:   nodeRevision(stat),
		SizeBytes:  stat.size,
	}
}

func safeModifiedAt(unixNano int64) *string {
	value := time.Unix(0, unixNano).UTC()
	if value.Year() < 1 || value.Year() > 9999 {
		return nil
	}
	formatted := value.Format(time.RFC3339Nano)
	return &formatted
}

func nodeRevision(stat nodeStat) string {
	digest := sha256.Sum256([]byte(fmt.Sprintf(
		"%s\x00%s\x00%s\x00%d\x00%d\x00%d\x00%d",
		stat.identity.volumeID,
		stat.identity.fileID,
		stat.kind,
		stat.size,
		stat.mode,
		stat.modifiedUnixNano,
		stat.changedUnixNano,
	)))
	return base64.RawURLEncoding.EncodeToString(digest[:])
}

func canonicalFileID(value string) bool {
	_, err := hex.DecodeString(value)
	return err == nil
}
