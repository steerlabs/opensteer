package phone

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/danielpaulus/go-ios/ios"
	"github.com/steerlabs/opensteer/iphone-bridge/internal/wire"
	"howett.net/plist"
)

func writeSetupImageBuild(t *testing.T, root, build, cryptexVersion string) {
	t.Helper()
	if err := os.MkdirAll(root, 0700); err != nil {
		t.Fatal(err)
	}
	entry := func(path string) interface{} {
		return map[string]interface{}{"Info": map[string]interface{}{"Path": path}}
	}
	identities := []interface{}{
		map[string]interface{}{"Manifest": map[string]interface{}{"PersonalizedDMG": entry("image.dmg"), "LoadableTrustCache": entry("cache")}},
	}
	files := map[string][]byte{
		"image.dmg": []byte("synthetic image " + build),
		"cache":     []byte("synthetic cache"),
	}
	if cryptexVersion != "" {
		identities = append(identities, map[string]interface{}{
			"Manifest": map[string]interface{}{
				"Cryptex1,GenericDmg":        entry("cryptex.dmg"),
				"Cryptex1,GenericTrustCache": entry("cryptex.cache"),
				"Cryptex1,GenericVolume":     entry("cryptex.root_hash"),
				"Cryptex1,CryptexInfoPlist":  entry("cryptex_info"),
			},
		})
		infoData, err := plist.Marshal(map[string]interface{}{
			"CFBundleIdentifier": "com.apple.MobileAsset.DDI",
			"CFBundleVersion":    cryptexVersion,
		}, plist.XMLFormat)
		if err != nil {
			t.Fatal(err)
		}
		files["cryptex.dmg"] = []byte("synthetic cryptex " + cryptexVersion)
		files["cryptex.cache"] = []byte("synthetic cryptex cache")
		files["cryptex.root_hash"] = []byte("synthetic root hash")
		files["cryptex_info"] = infoData
	}
	data, err := plist.Marshal(map[string]interface{}{"ProductBuildVersion": build, "BuildIdentities": identities}, plist.XMLFormat)
	if err != nil {
		t.Fatal(err)
	}
	files["BuildManifest.plist"] = data
	for name, content := range files {
		if err := os.WriteFile(filepath.Join(root, name), content, 0600); err != nil {
			t.Fatal(err)
		}
	}
}

func writeSetupImage(t *testing.T, root string) {
	t.Helper()
	writeSetupImageBuild(t, root, "27B52", "")
}

func TestImagesRefreshFindsLaterInstallOrdersNewestFirstAndDeduplicates(t *testing.T) {
	m := newTestManager(t)
	older := filepath.Join(t.TempDir(), "Older")
	newer := filepath.Join(t.TempDir(), "Newer")
	refresh := func(roots ...string) imagesResult {
		t.Helper()
		params, _ := json.Marshal(wire.ImagesParams{ImageRoots: roots})
		result, err := m.Call(context.Background(), wire.Request{Method: "images.refresh", Params: params})
		if err != nil {
			t.Fatal(err)
		}
		return result.(imagesResult)
	}
	if len(refresh(older).Images) != 0 {
		t.Fatal("found missing image")
	}
	writeSetupImageBuild(t, older, "27A9275", "27.1.9275.0")
	writeSetupImageBuild(t, newer, "27B52", "27.2.52.0")
	// Older root listed first, plus a duplicate path: newest must still be tried first.
	result := refresh(older, newer, older)
	if len(result.Images) != 2 || result.Images[0].Build != "27B52" || result.Images[1].Build != "27A9275" {
		t.Fatalf("unexpected image order: %+v", result)
	}
	if len(m.imagePaths) != 2 || m.imagePaths[0] != newer || m.imagePaths[1] != older {
		t.Fatalf("unexpected image paths: %+v", m.imagePaths)
	}
}

type selectedRSD struct{ reply ios.RsdHandshakeResponse }

func (r selectedRSD) Handshake() (ios.RsdHandshakeResponse, error)       { return r.reply, nil }
func (r selectedRSD) HandshakeAsHost() (ios.RsdHandshakeResponse, error) { return r.reply, nil }
func (r selectedRSD) Close() error                                       { return nil }

type prepareUSB struct {
	fakeUSB
	session *Session
}

func (f *prepareUSB) Inspect(context.Context, ios.DeviceEntry) (Inspection, error) {
	return Inspection{Pairing: "paired", DeveloperMode: "enabled", Model: "iPhone19,4", OSVersion: "27.2", Build: "24B91020", Reason: wire.QualificationRequired}, nil
}

func (f *prepareUSB) Open(context.Context, context.Context, ios.DeviceEntry) (*Session, error) {
	return f.session, nil
}

func TestPrepareReusesAlreadyWorkingDeveloperServicesWithoutMounting(t *testing.T) {
	m := newTestManager(t)
	// Mac has only an older local DDI (e.g. Xcode 27.1), while the iPhone already exposes live services from another Mac's 27.2 DDI.
	older := filepath.Join(t.TempDir(), "Xcode27.1")
	writeSetupImageBuild(t, older, "27A9275", "27.1.9275.0")
	m.refreshImages([]string{older})

	identity := "cross-mac-ddi-fixture"
	services := map[string]ios.RsdServiceEntry{
		screenshotService: {Port: 1001},
		hidService:        {Port: 1002},
		deviceInfoService: {Port: 1003},
	}
	s := &Session{identity: identity, newRSD: func(context.Context) (RSD, error) {
		return selectedRSD{ios.RsdHandshakeResponse{Udid: identity, Services: services}}, nil
	}}
	m.usb = &prepareUSB{session: s}
	mounted := 0
	m.mountImage = func(context.Context, *Session, ios.DeviceEntry, string) error {
		mounted++
		return wire.Fail(wire.PhoneInUse)
	}
	entry := ios.DeviceEntry{DeviceID: 1, Properties: ios.DeviceProperties{SerialNumber: identity, ConnectionType: "USB"}}
	m.inventory.Replace([]ios.DeviceEntry{entry})
	if err := m.reconcile(); err != nil {
		t.Fatal(err)
	}
	p := m.phones[m.identities[identity]]
	params, _ := json.Marshal(wire.PhoneRef{LocalPhoneID: p.id, NativeEpoch: p.epoch})
	result, err := m.Call(context.Background(), wire.Request{Method: "setup.prepareDeveloperServices", Params: params})
	if err != nil {
		t.Fatalf("prepare rejected already-working services: %v", err)
	}
	inspection := result.(Inspection)
	if inspection.Image != "mounted" || inspection.Tunnel != "ready" {
		t.Fatalf("unexpected inspection: %+v", inspection)
	}
	if mounted != 0 {
		t.Fatalf("mounted %d times when services were already present", mounted)
	}
}

func TestEnsureDeveloperServicesFallsThroughOnlyOnIncompatibleAndUsesRefreshedMacImages(t *testing.T) {
	m := newTestManager(t)
	first := filepath.Join(t.TempDir(), "NewerIncompatible")
	second := filepath.Join(t.TempDir(), "Compatible")
	writeSetupImageBuild(t, first, "27B52", "27.2.52.0")
	writeSetupImageBuild(t, second, "27A9275", "27.1.9275.0")
	m.refreshImages([]string{second, first})

	identity := "fallback-fixture"
	services := map[string]ios.RsdServiceEntry{}
	screen, _, _ := screenFixture(t)
	s := &Session{identity: identity, screen: screen, newRSD: func(context.Context) (RSD, error) {
		return selectedRSD{ios.RsdHandshakeResponse{Udid: identity, Services: services}}, nil
	}}
	var tried []string
	m.mountImage = func(ctx context.Context, session *Session, _ ios.DeviceEntry, staged string) error {
		raw, err := os.ReadFile(filepath.Join(staged, "BuildManifest.plist"))
		if err != nil {
			t.Fatal(err)
		}
		var manifest imageManifest
		if _, err := plist.Unmarshal(raw, &manifest); err != nil {
			t.Fatal(err)
		}
		tried = append(tried, manifest.ProductBuildVersion)
		if manifest.ProductBuildVersion == "27B52" {
			return wire.Fail(wire.ImageIncompatible)
		}
		for _, name := range []string{screenshotService, hidService, deviceInfoService} {
			services[name] = ios.RsdServiceEntry{Port: 1234}
		}
		return session.Refresh(ctx)
	}
	p := &localPhone{identity: identity, entry: ios.DeviceEntry{DeviceID: 1, Properties: ios.DeviceProperties{SerialNumber: identity, ConnectionType: "USB"}}}
	if err := m.ensureDeveloperServices(context.Background(), p, s); err != nil {
		t.Fatal(err)
	}
	if len(tried) != 2 || tried[0] != "27B52" || tried[1] != "27A9275" {
		t.Fatalf("expected newest-first fallback, tried %v", tried)
	}

	// Non-compatibility error stops immediately without trying older images.
	for name := range services {
		delete(services, name)
	}
	tried = nil
	m.mountImage = func(context.Context, *Session, ios.DeviceEntry, string) error {
		tried = append(tried, "attempt")
		return wire.Fail(wire.PersonalizationNetwork)
	}
	err := m.ensureDeveloperServices(context.Background(), p, s)
	var failure *wire.Failure
	if !errors.As(err, &failure) || failure.Code != wire.PersonalizationNetwork || len(tried) != 1 {
		t.Fatalf("expected immediate stop on network failure, got err=%v tried=%v", err, tried)
	}
}

func TestCurrentMacImagesRestoreServicesAfterRestartWithoutPerPhonePersistence(t *testing.T) {
	m := newTestManager(t)
	oldRoot := filepath.Join(t.TempDir(), "OldXcode")
	newRoot := filepath.Join(t.TempDir(), "NewXcode")
	writeSetupImageBuild(t, oldRoot, "27A9275", "27.1.9275.0")
	m.refreshImages([]string{oldRoot})
	identity := "remount-fixture"
	p := &localPhone{identity: identity}
	services := map[string]ios.RsdServiceEntry{}
	screen, _, _ := screenFixture(t)
	s := &Session{identity: identity, screen: screen, newRSD: func(context.Context) (RSD, error) {
		return selectedRSD{ios.RsdHandshakeResponse{Udid: identity, Services: services}}, nil
	}}
	mounted := 0
	var lastBuild string
	m.mountImage = func(ctx context.Context, session *Session, _ ios.DeviceEntry, staged string) error {
		mounted++
		raw, err := os.ReadFile(filepath.Join(staged, "BuildManifest.plist"))
		if err != nil {
			t.Fatal(err)
		}
		var manifest imageManifest
		if _, err := plist.Unmarshal(raw, &manifest); err != nil {
			t.Fatal(err)
		}
		lastBuild = manifest.ProductBuildVersion
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
	if mounted != 1 || lastBuild != "27A9275" {
		t.Fatalf("readiness did not remount current image: mounted=%d build=%s", mounted, lastBuild)
	}
	// Updating Xcode replaces the available DDI; a later reboot mounts the updated image automatically.
	writeSetupImageBuild(t, newRoot, "27B52", "27.2.52.0")
	m.refreshImages([]string{newRoot})
	for name := range services {
		delete(services, name)
	}
	if _, err := m.open(context.Background(), &wire.SessionParams{BindingToken: p.binding, SessionID: "runtime", RunID: "run", Access: "control"}); err != nil {
		t.Fatal(err)
	}
	if mounted != 2 || lastBuild != "27B52" {
		t.Fatalf("session open did not remount refreshed image after reboot: mounted=%d build=%s", mounted, lastBuild)
	}
	if err := m.ensureDeveloperServices(context.Background(), p, s); err != nil {
		t.Fatal(err)
	}
	if mounted != 2 {
		t.Fatal("compatible services were remounted")
	}

	// If a reboot later fails to mount because Xcode is too old, the roster must report
	// developer-image-incompatible for DDI-backed capabilities while keeping installedApps
	// available whenever its own RSD service is present.
	for name := range services {
		delete(services, name)
	}
	services[inventoryService] = ios.RsdServiceEntry{Port: 4321}
	m.mountImage = func(context.Context, *Session, ios.DeviceEntry, string) error {
		return wire.Fail(wire.ImageIncompatible)
	}
	if err := m.probe(context.Background(), p.binding); err == nil {
		t.Fatal("expected incompatible mount failure")
	}
	candidate := m.roster().Candidates[0]
	if candidate.Capabilities == nil || candidate.Capabilities.Observe == nil || *candidate.Capabilities.Observe != wire.ImageIncompatible {
		t.Fatalf("expected roster observe capability %q, got %+v", wire.ImageIncompatible, candidate.Capabilities)
	}
	if candidate.Capabilities.InstalledApps != nil {
		t.Fatalf("expected installedApps to stay available when inventoryService is live, got %v", *candidate.Capabilities.InstalledApps)
	}

	// A failed RSD refresh must invalidate readiness even if core ports were cached earlier.
	for _, name := range []string{screenshotService, hidService, deviceInfoService} {
		services[name] = ios.RsdServiceEntry{Port: 1234}
	}
	if err := m.probe(context.Background(), p.binding); err != nil {
		t.Fatal(err)
	}
	if got := m.roster().Candidates[0].Capabilities.Observe; got != nil {
		t.Fatalf("expected ready before refresh failure, got %v", *got)
	}
	s.newRSD = func(context.Context) (RSD, error) {
		return nil, wire.Fail(wire.TunnelFailed)
	}
	if err := m.probe(context.Background(), p.binding); err == nil {
		t.Fatal("expected refresh failure")
	}
	if got := m.roster().Candidates[0].Capabilities.Observe; got == nil || *got != wire.TunnelFailed {
		t.Fatalf("expected %q after failed refresh, got %v", wire.TunnelFailed, got)
	}

	// A subsequent successful session.open must clear the stale refresh readinessReason.
	p.sessionID = ""
	s.newRSD = func(context.Context) (RSD, error) {
		return selectedRSD{ios.RsdHandshakeResponse{Udid: identity, Services: services}}, nil
	}
	if _, err := m.open(context.Background(), &wire.SessionParams{BindingToken: p.binding, SessionID: "recovered", RunID: "run", Access: "observe"}); err != nil {
		t.Fatal(err)
	}
	if got := m.roster().Candidates[0].Capabilities.Observe; got != nil {
		t.Fatalf("expected recovered phone to be ready after session.open, got %v", *got)
	}
	p.sessionID = ""

	// A probe whose epoch changed while in flight must not clobber the newer epoch's readiness.
	p.readinessReason = ""
	s.setDDIReason("")
	s.newRSD = func(context.Context) (RSD, error) {
		m.mu.Lock()
		p.epoch++
		m.mu.Unlock()
		return nil, wire.Fail(wire.TunnelFailed)
	}
	err := m.probe(context.Background(), p.binding)
	var failure *wire.Failure
	if !errors.As(err, &failure) || failure.Code != wire.StaleEpoch {
		t.Fatalf("expected stale-native-epoch on epoch race, got %v", err)
	}
	if p.readinessReason != "" {
		t.Fatalf("stale probe overwrote readinessReason with %q", p.readinessReason)
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
