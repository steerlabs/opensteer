package phone

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/danielpaulus/go-ios/ios"
	"github.com/steerlabs/opensteer/iphone-bridge/internal/wire"
	"howett.net/plist"
)

func TestImageValidation(t *testing.T) {
	root := t.TempDir()
	write := func(path string) {
		t.Helper()
		m := map[string]interface{}{"ProductBuildVersion": "TEST", "BuildIdentities": []interface{}{map[string]interface{}{"Manifest": map[string]interface{}{"PersonalizedDMG": map[string]interface{}{"Info": map[string]interface{}{"Path": path}}, "LoadableTrustCache": map[string]interface{}{"Info": map[string]interface{}{"Path": "cache"}}}}}}
		data, _ := plist.Marshal(m, plist.XMLFormat)
		if err := os.WriteFile(filepath.Join(root, "BuildManifest.plist"), data, 0600); err != nil {
			t.Fatal(err)
		}
	}
	_ = os.WriteFile(filepath.Join(root, "image.dmg"), []byte("synthetic image"), 0600)
	_ = os.WriteFile(filepath.Join(root, "cache"), []byte("synthetic cache"), 0600)
	write("image.dmg")
	image, err := ValidateImage(root)
	if err != nil {
		t.Fatal(err)
	}
	image.Close()
	for _, path := range []string{"../outside", "/absolute", "", "https://devicebox.invalid/image"} {
		write(path)
		if image, err := ValidateImage(root); err == nil {
			image.Close()
			t.Fatalf("accepted %q", path)
		}
	}
	write("escape")
	_ = os.Symlink(filepath.Join(t.TempDir(), "outside"), filepath.Join(root, "escape"))
	if image, err := ValidateImage(root); err == nil {
		image.Close()
		t.Fatal("accepted symlink")
	}
}

func TestXcode27ManifestShape(t *testing.T) {
	root := t.TempDir()
	identities := make([]interface{}, 0, 141)
	entry := func(path string) interface{} {
		return map[string]interface{}{"Info": map[string]interface{}{"Path": path}}
	}
	for range 140 {
		identities = append(identities, map[string]interface{}{"Manifest": map[string]interface{}{"PersonalizedDMG": entry("personalized.dmg"), "LoadableTrustCache": entry("cache")}})
	}
	identities = append(identities, map[string]interface{}{"Manifest": map[string]interface{}{"Cryptex1,GenericDmg": entry("cryptex.dmg"), "Cryptex1,GenericTrustCache": entry("cryptex.cache"), "Cryptex1,GenericVolume": entry("root_hash"), "Cryptex1,CryptexInfoPlist": entry("cryptex_info")}})
	data, err := plist.Marshal(map[string]interface{}{"ProductBuildVersion": "27B52", "BuildIdentities": identities}, plist.XMLFormat)
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"personalized.dmg", "cryptex.dmg", "cache", "cryptex.cache", "root_hash", "cryptex_info"} {
		if err := os.WriteFile(filepath.Join(root, name), []byte("synthetic"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(root, "BuildManifest.plist"), data, 0600); err != nil {
		t.Fatal(err)
	}
	image, err := ValidateImage(root)
	if err != nil {
		t.Fatal(err)
	}
	defer image.Close()
	if image.Build != "27B52" || len(image.files) != 6 {
		t.Fatalf("shared manifest paths: %+v", image)
	}
}

type fakeImageMounter struct {
	existing  [][]byte
	mounted   int
	unmounted int
	mountErr  error
}

func (f *fakeImageMounter) ListImages() ([][]byte, error)       { return f.existing, nil }
func (f *fakeImageMounter) MountImage(string) error             { f.mounted++; return f.mountErr }
func (f *fakeImageMounter) UnmountImage() error                 { f.unmounted++; return nil }
func (f *fakeImageMounter) IsImageMounted(string) (bool, error) { return false, nil }
func (f *fakeImageMounter) Close() error                        { return nil }

func TestMountedImageWithoutServicesNeverReportsPhoneInUseOrUnmounts(t *testing.T) {
	services := map[string]ios.RsdServiceEntry{}
	s := &Session{identity: "mounted-no-services", newRSD: func(context.Context) (RSD, error) {
		return selectedRSD{ios.RsdHandshakeResponse{Udid: "mounted-no-services", Services: services}}, nil
	}}
	m := &fakeImageMounter{existing: [][]byte{[]byte("com.apple.MobileAsset.DDI@27.1.0.0")}}
	err := mountDeveloperImageWithMounter(context.Background(), s, m, "/unused")
	var failure *wire.Failure
	if !errors.As(err, &failure) || failure.Code != wire.ServiceMissing {
		t.Fatalf("expected native-service-missing, got %v", err)
	}
	if m.unmounted != 0 || m.mounted != 0 {
		t.Fatalf("expected no unmount or mount when another image is present, got unmounted=%d mounted=%d", m.unmounted, m.mounted)
	}

	// If a parallel mount finished right before refresh, accept the live services.
	services[screenshotService] = ios.RsdServiceEntry{Port: 1001}
	services[hidService] = ios.RsdServiceEntry{Port: 1002}
	services[deviceInfoService] = ios.RsdServiceEntry{Port: 1003}
	if err := mountDeveloperImageWithMounter(context.Background(), s, m, "/unused"); err != nil {
		t.Fatalf("expected success once services appeared, got %v", err)
	}
	if m.unmounted != 0 || m.mounted != 0 {
		t.Fatalf("unexpected mount/unmount: %+v", m)
	}
}

func TestStageFailureDoesNotLeakFilesystemPaths(t *testing.T) {
	source := t.TempDir()
	writeSetupImageBuild(t, source, "27B52", "27.2.52.0")
	image, err := ValidateImage(source)
	if err != nil {
		t.Fatal(err)
	}
	defer image.Close()
	// Make a colliding file inside the staged dir impossible? Instead create a read-only dir
	// or a file at a sentinel path inside the staging root; MkdirTemp fails with a sentinel path.
	sentinel := filepath.Join(t.TempDir(), "sentinel-private-user-home-dir")
	if err := os.MkdirAll(sentinel, 0500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(sentinel, 0700) })
	// Also test the WriteFile/OpenFile failure path by passing a file that exists inside a writable dir:
	// First verify MkdirTemp failure hides sentinel path.
	_, cleanup, err := image.Stage(context.Background(), sentinel)
	if cleanup != nil {
		cleanup()
	}
	if err == nil {
		t.Fatal("expected staging failure in read-only root")
	}
	if strings.Contains(err.Error(), "sentinel-private-user-home-dir") {
		t.Fatalf("staging error leaked filesystem path: %v", err)
	}
	// Listing the same path twice passes root.Open and fails os.OpenFile(O_EXCL) inside the staged directory.
	colliding := &Image{
		root:     image.root,
		manifest: []byte("m"),
		files:    []string{"image.dmg", "image.dmg"},
	}
	stageRoot := filepath.Join(t.TempDir(), "sentinel-stage-path-secret")
	if err := os.MkdirAll(stageRoot, 0700); err != nil {
		t.Fatal(err)
	}
	_, cleanup2, err := colliding.Stage(context.Background(), stageRoot)
	if cleanup2 != nil {
		cleanup2()
	}
	var failure *wire.Failure
	if !errors.As(err, &failure) || failure.Code != wire.ImageMountFailed {
		t.Fatalf("expected typed %q failure, got %v", wire.ImageMountFailed, err)
	}
	if strings.Contains(err.Error(), "sentinel-stage-path-secret") {
		t.Fatalf("staging error leaked filesystem path: %v", err)
	}
}
