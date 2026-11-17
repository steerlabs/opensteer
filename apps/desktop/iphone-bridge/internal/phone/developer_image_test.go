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
