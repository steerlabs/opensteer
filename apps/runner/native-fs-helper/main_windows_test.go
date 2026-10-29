//go:build windows

package main

import (
	"encoding/base64"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"golang.org/x/sys/windows"
)

func TestWindowsWorkspaceOperationsAndIdentity(t *testing.T) {
	workspace := t.TempDir()
	if err := os.Mkdir(filepath.Join(workspace, "docs"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(workspace, "docs", "a.txt"), []byte("Needle one\nneedle two\n"), 0600); err != nil {
		t.Fatal(err)
	}
	restoreACL := denyDeleteForCurrentUser(t, filepath.Join(workspace, "docs", "a.txt"))
	defer restoreACL()

	identity, err := executeWindowsTest(request{Operation: "directory-identity", Path: ".", Root: workspace})
	if err != nil {
		t.Fatal(err)
	}
	firstIdentity := identity.(directoryIdentityResult)
	if firstIdentity.Kind != "windows" || len(firstIdentity.FileID) != 32 || firstIdentity.VolumeID == "" {
		t.Fatalf("unexpected Windows directory identity: %#v", firstIdentity)
	}
	filesPage, err := executeWindowsTest(request{
		ExpectedRootIdentity: &firstIdentity,
		Limit:                10,
		Operation:            "files-list",
		PathSegmentsBase64:   []string{base64.RawURLEncoding.EncodeToString([]byte("docs"))},
		Root:                 workspace,
	})
	if err != nil {
		t.Fatal(err)
	}
	filesEntries := filesPage.(filesListResult).Entries
	if len(filesEntries) != 1 || filesEntries[0].NameBase64 != base64.RawURLEncoding.EncodeToString([]byte("a.txt")) {
		t.Fatalf("unexpected Windows Files page: %#v", filesPage)
	}
	filesRead, err := executeWindowsTest(request{
		ExpectedRootIdentity: &firstIdentity,
		MaxBytes:             100,
		Operation:            "files-read-range",
		PathSegmentsBase64: []string{
			base64.RawURLEncoding.EncodeToString([]byte("docs")),
			filesEntries[0].NameBase64,
		},
		Root: workspace,
	})
	if err != nil {
		t.Fatal(err)
	}
	filesContent, err := base64.StdEncoding.DecodeString(filesRead.(filesReadRangeResult).ContentBase64)
	if err != nil || string(filesContent) != "Needle one\nneedle two\n" {
		t.Fatalf("unexpected Windows Files read: %q, %v", filesContent, err)
	}

	listed, err := executeWindowsTest(request{MaxDepth: 2, MaxEntries: 100, Operation: "list", Path: ".", Root: workspace})
	if err != nil {
		t.Fatal(err)
	}
	entries := listed.(listResult).Entries
	if len(entries) != 2 || entries[0].Path != "docs" || entries[1].Path != "docs/a.txt" {
		t.Fatalf("unexpected listing: %#v", entries)
	}

	read, err := executeWindowsTest(request{Operation: "read", Path: "docs/a.txt", Root: workspace})
	if err != nil {
		t.Fatal(err)
	}
	content, err := base64.StdEncoding.DecodeString(read.(readResult).ContentBase64)
	if err != nil || string(content) != "Needle one\nneedle two\n" {
		t.Fatalf("unexpected read: %q, %v", content, err)
	}
	restoreACL()

	created, err := executeWindowsTest(request{Operation: "ensure-directory", Path: "nested/work", Root: workspace})
	if err != nil {
		t.Fatal(err)
	}
	if created.(directoryIdentityResult).Kind != "windows" {
		t.Fatalf("unexpected created directory identity: %#v", created)
	}
	if _, err := executeWindowsTest(request{Operation: "ensure-directory", Path: "nested/work", Root: workspace}); !hasHelperCode(err, "already-exists") {
		t.Fatalf("exclusive directory creation adopted an existing path: %v", err)
	}
	if _, err := executeWindowsTest(request{Operation: "ensure-directory", Path: "nested/work", Resume: true, Root: workspace}); err != nil {
		t.Fatalf("durable provisioning resume failed: %v", err)
	}

	if _, err := executeWindowsTest(request{Content: "created", Operation: "write", Path: "nested/work/new.txt", Root: workspace}); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(workspace, "CaseDir"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(workspace, "CaseDir", "Mixed.TXT"), []byte("case-insensitive"), 0600); err != nil {
		t.Fatal(err)
	}
	caseRead, err := executeWindowsTest(request{Operation: "read", Path: "casedir/mixed.txt", Root: workspace})
	if err != nil {
		t.Fatal(err)
	}
	caseContent, err := base64.StdEncoding.DecodeString(caseRead.(readResult).ContentBase64)
	if err != nil || string(caseContent) != "case-insensitive" {
		t.Fatalf("case-insensitive lookup failed: %q, %v", caseContent, err)
	}
	if _, err := executeWindowsTest(request{NewText: "center", OldText: "Needle", Operation: "replace", Path: "docs/a.txt", Root: workspace}); err != nil {
		t.Fatal(err)
	}
	updated, err := os.ReadFile(filepath.Join(workspace, "docs", "a.txt"))
	if err != nil || !strings.HasPrefix(string(updated), "center one") {
		t.Fatalf("unexpected replacement: %q, %v", updated, err)
	}

	original := workspace + ".original"
	if err := os.Rename(workspace, original); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(workspace, 0700); err != nil {
		t.Fatal(err)
	}
	replacement, err := executeWindowsTest(request{Operation: "directory-identity", Path: ".", Root: workspace})
	if err != nil {
		t.Fatal(err)
	}
	if replacement.(directoryIdentityResult) == firstIdentity {
		t.Fatal("directory replacement kept the same Windows volume/file identity")
	}
}

func TestWindowsDesktopPrivateAuthorityAppliesStrictACLAndPinsRoot(t *testing.T) {
	rootPath := filepath.Join(t.TempDir(), "Opensteer")
	createdValue, err := executeWithRootPolicy(request{
		Operation: "desktop-ensure-root", Root: rootPath, RootPolicy: "desktop-private",
	}, true)
	if err != nil {
		t.Fatal(err)
	}
	created := createdValue.(desktopPrivateRootResult)
	if !created.Created || created.Identity.Kind != "windows" {
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
	root, err := openDesktopPrivateRoot(rootPath)
	if err != nil {
		t.Fatal(err)
	}
	handle, _, err := root.openDesktopNode([]string{"private", "secret.json"}, false)
	if err != nil {
		root.close()
		t.Fatal(err)
	}
	if err := assertDesktopPrivateNode(handle, false); err != nil {
		closeNode(handle)
		root.close()
		t.Fatal(err)
	}
	closeNode(handle)
	root.close()

	original := rootPath + ".original"
	if err := os.Rename(rootPath, original); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(rootPath, 0700); err != nil {
		t.Fatal(err)
	}
	read := requestFor("desktop-read-file", "private/secret.json")
	read.MaxBytes = 32
	if _, err := executeWithRootPolicy(read, true); !hasHelperCode(err, "root-replaced") {
		t.Fatalf("Desktop private authority accepted a replaced root: %v", err)
	}
}

func denyDeleteForCurrentUser(t *testing.T, path string) func() {
	t.Helper()
	descriptor, err := windows.GetNamedSecurityInfo(
		path,
		windows.SE_FILE_OBJECT,
		windows.DACL_SECURITY_INFORMATION,
	)
	if err != nil {
		t.Fatal(err)
	}
	original, _, err := descriptor.DACL()
	if err != nil {
		t.Fatal(err)
	}
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		t.Fatal(err)
	}
	var pinner runtime.Pinner
	pinner.Pin(user.User.Sid)
	access := []windows.EXPLICIT_ACCESS{{
		AccessPermissions: windows.DELETE,
		AccessMode:        windows.DENY_ACCESS,
		Trustee: windows.TRUSTEE{
			TrusteeForm:  windows.TRUSTEE_IS_SID,
			TrusteeType:  windows.TRUSTEE_IS_USER,
			TrusteeValue: windows.TrusteeValueFromSID(user.User.Sid),
		},
	}}
	denied, err := windows.ACLFromEntries(access, original)
	if err != nil {
		pinner.Unpin()
		t.Fatal(err)
	}
	if err := windows.SetNamedSecurityInfo(
		path,
		windows.SE_FILE_OBJECT,
		windows.DACL_SECURITY_INFORMATION,
		nil,
		nil,
		denied,
		nil,
	); err != nil {
		pinner.Unpin()
		t.Fatal(err)
	}
	restored := false
	return func() {
		if restored {
			return
		}
		restored = true
		if err := windows.SetNamedSecurityInfo(
			path,
			windows.SE_FILE_OBJECT,
			windows.DACL_SECURITY_INFORMATION,
			nil,
			nil,
			original,
			nil,
		); err != nil {
			t.Errorf("restore test file ACL: %v", err)
		}
		runtime.KeepAlive(descriptor)
		pinner.Unpin()
	}
}

func TestWindowsCreatesTheManagedRootThroughNativeHandles(t *testing.T) {
	root := filepath.Join(t.TempDir(), "missing", "workspaces")
	first, err := executeWindowsTest(request{Operation: "ensure-root", Root: root})
	if err != nil {
		t.Fatal(err)
	}
	created := first.(ensureRootResult)
	if !created.Created || created.Identity.Kind != "windows" {
		t.Fatalf("unexpected first root result: %#v", created)
	}
	second, err := executeWindowsTest(request{Operation: "ensure-root", Root: root})
	if err != nil {
		t.Fatal(err)
	}
	replayed := second.(ensureRootResult)
	if replayed.Created || replayed.Identity != created.Identity {
		t.Fatalf("unexpected root replay result: %#v", replayed)
	}
}

func TestWindowsRejectsReparsePointsAndAmbiguousNames(t *testing.T) {
	workspace := t.TempDir()
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "outside.txt"), []byte("outside"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(workspace, "escape")); err == nil {
		_, readErr := executeWindowsTest(request{Operation: "read", Path: "escape/outside.txt", Root: workspace})
		if readErr == nil {
			t.Fatal("directory reparse point escaped the Workspace")
		}
		identity, identityErr := executeWindowsTest(request{Operation: "directory-identity", Path: ".", Root: workspace})
		if identityErr != nil {
			t.Fatal(identityErr)
		}
		expected := identity.(directoryIdentityResult)
		_, filesErr := executeWindowsTest(request{
			ExpectedRootIdentity: &expected,
			MaxBytes:             100,
			Operation:            "files-read-range",
			PathSegmentsBase64: []string{
				base64.RawURLEncoding.EncodeToString([]byte("escape")),
				base64.RawURLEncoding.EncodeToString([]byte("outside.txt")),
			},
			Root: workspace,
		})
		if filesErr == nil {
			t.Fatal("Windows Files read followed a directory reparse point")
		}
	}

	invalid := []string{
		`..\outside.txt`,
		`docs\outside.txt`,
		`target.txt:alternate`,
		`CON`,
		`con.txt`,
		`COM¹.log`,
		`Lpt9.data`,
		`CONIN$`,
		`file.`,
		`file `,
	}
	for _, candidate := range invalid {
		_, err := executeWindowsTest(request{Operation: "read", Path: candidate, Root: workspace})
		var typed *helperError
		if !errors.As(err, &typed) || (typed.code != "invalid-path" && typed.code != "outside-workspace") {
			t.Fatalf("Windows path %q was not rejected before filesystem access: %v", candidate, err)
		}
	}
}

func TestWindowsVolumeAndNamespaceValidation(t *testing.T) {
	validVolumes := []string{`C:`, `z:`, `\\server\share`, `\\server.example\share$`}
	for _, volume := range validVolumes {
		if !validWindowsVolumeName(volume) {
			t.Fatalf("expected valid Windows volume %q", volume)
		}
	}
	invalidVolumes := []string{"", `C`, `1:`, `\\server`, `\\server\`, `\\server\share\extra`, `\\?\C:`}
	for _, volume := range invalidVolumes {
		if validWindowsVolumeName(volume) {
			t.Fatalf("accepted invalid Windows volume %q", volume)
		}
	}
	deviceNamespaces := []string{
		`\\?\C:\workspaces`,
		`//?/C:/workspaces`,
		`\\.\C:\workspaces`,
		`\??\C:\workspaces`,
		`\\??\C:\workspaces`,
		`\Device\HarddiskVolume1\workspaces`,
		`\\GLOBALROOT\Device\HarddiskVolume1\workspaces`,
	}
	for _, candidate := range deviceNamespaces {
		if !hasWindowsDeviceNamespace(strings.ReplaceAll(candidate, "/", `\`)) {
			t.Fatalf("device namespace %q was not rejected", candidate)
		}
	}
}

func TestWindowsIsolatedRootsRequireAVolumeBoundary(t *testing.T) {
	workspace := t.TempDir()
	_, err := execute(request{MaxDepth: 1, MaxEntries: 1, Operation: "list", Path: ".", Root: workspace, RootPolicy: "isolated-mount"})
	if !hasHelperCode(err, "root-not-mount") {
		t.Fatalf("ordinary Windows directory was accepted as an isolated mount: %v", err)
	}
}

func executeWindowsTest(input request) (any, error) {
	input.RootPolicy = "managed-local"
	return executeWithRootPolicy(input, true)
}

func hasHelperCode(err error, code string) bool {
	var typed *helperError
	return errors.As(err, &typed) && typed.code == code
}
