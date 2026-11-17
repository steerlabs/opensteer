package phone

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/danielpaulus/go-ios/ios"
	"github.com/steerlabs/opensteer/iphone-bridge/internal/wire"
	"howett.net/plist"
)

func writeSetupImage(t *testing.T, root string) {
	t.Helper()
	if err := os.MkdirAll(root, 0700); err != nil {
		t.Fatal(err)
	}
	entry := func(path string) interface{} {
		return map[string]interface{}{"Info": map[string]interface{}{"Path": path}}
	}
	data, err := plist.Marshal(map[string]interface{}{"ProductBuildVersion": "27B52", "BuildIdentities": []interface{}{map[string]interface{}{"Manifest": map[string]interface{}{"PersonalizedDMG": entry("image.dmg"), "LoadableTrustCache": entry("cache")}}}}, plist.XMLFormat)
	if err != nil {
		t.Fatal(err)
	}
	for name, data := range map[string][]byte{"BuildManifest.plist": data, "image.dmg": []byte("synthetic image"), "cache": []byte("synthetic cache")} {
		if err := os.WriteFile(filepath.Join(root, name), data, 0600); err != nil {
			t.Fatal(err)
		}
	}
}
func TestImagesRefreshFindsLaterInstallAndReplacesHandles(t *testing.T) {
	m := newTestManager(t)
	root := filepath.Join(t.TempDir(), "Restore")
	refresh := func() imagesResult {
		t.Helper()
		params, _ := json.Marshal(wire.ImagesParams{ImageRoots: []string{root}})
		result, err := m.Call(context.Background(), wire.Request{Method: "images.refresh", Params: params})
		if err != nil {
			t.Fatal(err)
		}
		return result.(imagesResult)
	}
	if len(refresh().Images) != 0 {
		t.Fatal("found missing image")
	}
	writeSetupImage(t, root)
	first := refresh()
	if len(first.Images) != 1 || first.Images[0].Build != "27B52" {
		t.Fatalf("refresh: %+v", first)
	}
	second := refresh()
	if len(second.Images) != 1 || second.Images[0].Handle == first.Images[0].Handle || m.images[first.Images[0].Handle] != "" {
		t.Fatal("stale handles survived refresh")
	}
}

type selectedRSD struct{ reply ios.RsdHandshakeResponse }

func (r selectedRSD) Handshake() (ios.RsdHandshakeResponse, error)       { return r.reply, nil }
func (r selectedRSD) HandshakeAsHost() (ios.RsdHandshakeResponse, error) { return r.reply, nil }
func (r selectedRSD) Close() error                                       { return nil }
func TestSelectedImageRestoresServicesAfterRestart(t *testing.T) {
	m := newTestManager(t)
	path := filepath.Join(t.TempDir(), "Restore")
	writeSetupImage(t, path)
	identity := "remount-fixture"
	m.selectedImages[identity] = path
	if err := m.saveSelectedImages(); err != nil {
		t.Fatal(err)
	}
	m.selectedImages = map[string]string{}
	if err := m.loadSelectedImages(); err != nil {
		t.Fatal(err)
	}
	p := &localPhone{identity: identity}
	services := map[string]ios.RsdServiceEntry{}
	screen, _, _ := screenFixture(t)
	s := &Session{identity: identity, screen: screen, newRSD: func(context.Context) (RSD, error) {
		return selectedRSD{ios.RsdHandshakeResponse{Udid: identity, Services: services}}, nil
	}}
	mounted := 0
	m.mountImage = func(ctx context.Context, session *Session, _ ios.DeviceEntry, staged string) error {
		mounted++
		if _, err := os.Stat(filepath.Join(staged, "image.dmg")); err != nil {
			t.Fatal(err)
		}
		for _, name := range []string{screenshotService, hidService, deviceInfoService} {
			services[name] = ios.RsdServiceEntry{Port: 1234}
		}
		return session.Refresh(ctx)
	}
	p.session = s
	p.binding = "binding"
	p.id = "phone"
	p.epoch = 1
	p.entry = ios.DeviceEntry{DeviceID: 1, Properties: ios.DeviceProperties{SerialNumber: identity, ConnectionType: "USB"}}
	m.inventory.Replace([]ios.DeviceEntry{p.entry})
	m.identities[identity] = p.id
	if err := m.saveIdentities(); err != nil {
		t.Fatal(err)
	}
	p.lane = make(chan struct{}, 1)
	p.routeCtx = m.ctx
	m.phones[p.id] = p
	if err := m.probe(context.Background(), p.binding); err != nil {
		t.Fatal(err)
	}
	if mounted != 1 {
		t.Fatal("readiness did not remount selected image")
	}
	// A second reboot loses developer services while preserving the chosen image.
	for name := range services {
		delete(services, name)
	}
	if _, err := m.open(context.Background(), &wire.SessionParams{BindingToken: p.binding, SessionID: "runtime", RunID: "run", Access: "control"}); err != nil {
		t.Fatal(err)
	}
	if mounted != 2 {
		t.Fatal("session open did not remount after reboot")
	}
	if err := m.ensureDeveloperServices(context.Background(), p, s); err != nil {
		t.Fatal(err)
	}
	if mounted != 2 {
		t.Fatal("compatible services were remounted")
	}
}
func TestIOSGateAcceptsFutureMajorVersions(t *testing.T) {
	for _, version := range []string{"27", "27.2", "28.0", "100.1"} {
		if !supportedIOS(version) {
			t.Fatalf("refused %s", version)
		}
	}
	for _, version := range []string{"26.9", "17.0", "", "unknown", "-1", "27beta"} {
		if supportedIOS(version) {
			t.Fatalf("accepted %s", version)
		}
	}
}
