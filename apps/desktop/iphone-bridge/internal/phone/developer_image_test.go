package phone

import (
	"howett.net/plist"
	"os"
	"path/filepath"
	"testing"
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
