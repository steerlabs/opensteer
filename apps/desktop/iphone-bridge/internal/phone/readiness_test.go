package phone

import (
	"context"
	"encoding/json"
	"github.com/danielpaulus/go-ios/ios"
	"github.com/steerlabs/opensteer/iphone-bridge/internal/wire"
	"testing"
	"time"
)

func TestReadinessSeparatesCandidateEligibilityFromRuntimeCapabilities(t *testing.T) {
	m := newTestManager(t)
	d := ios.DeviceEntry{DeviceID: 1, Properties: ios.DeviceProperties{SerialNumber: "readiness-fixture", ConnectionType: "USB"}}
	m.inventory.Replace([]ios.DeviceEntry{d})
	if err := m.reconcile(); err != nil {
		t.Fatal(err)
	}
	p := m.phones[m.identities["readiness-fixture"]]
	assert := func(want string) map[string]interface{} {
		t.Helper()
		data, _ := json.Marshal(m.roster().Candidates[0])
		var result map[string]interface{}
		if err := json.Unmarshal(data, &result); err != nil {
			t.Fatal(err)
		}
		if result["reason"] != want && !(want == "" && result["reason"] == nil) {
			t.Fatalf("reason = %v, want %q", result["reason"], want)
		}
		return result
	}
	if got := assert("")["capabilities"].(map[string]interface{})["observe"]; got != "not-initialized" {
		t.Fatalf("unopened runtime capability: %v", got)
	}
	screen, _, _ := screenFixture(t)
	s := &Session{identity: p.identity, announced: true, screen: screen, services: ios.RsdHandshakeResponse{Udid: p.identity, Services: map[string]ios.RsdServiceEntry{}}}
	p.session = s
	if got := assert("")["capabilities"].(map[string]interface{})["observe"]; got != "native-service-missing" {
		t.Fatalf("missing runtime service: %v", got)
	}
	for _, service := range []string{deviceInfoService, "com.apple.coredevice.screencaptureservice", "com.apple.coredevice.hid.indigo", "com.apple.coredevice.appservice", "com.apple.mobile.installation_proxy.shim.remote"} {
		s.services.Services[service] = ios.RsdServiceEntry{Port: 1234}
	}
	if got := assert("")["capabilities"].(map[string]interface{})["observe"]; got != "lock-state-unknown" {
		t.Fatalf("unknown runtime lock: %v", got)
	}
	p.sessionID = "setup"
	p.binding = "binding"
	includeScreenshot := true
	if _, err := m.screenOperation(context.Background(), &wire.ObserveParams{ScreenRef: wire.ScreenRef{BindingToken: "binding", SessionID: "setup", NativeEpoch: p.epoch}, IncludeScreenshot: &includeScreenshot}); err != nil {
		t.Fatal(err)
	}
	result := assert("")
	caps := result["capabilities"].(map[string]interface{})
	if caps["observe"] != nil || caps["act"] != nil || caps["installedApps"] != nil || caps["launch"] != nil {
		t.Fatalf("wrong capabilities: %v", caps)
	}
	for service, operation := range map[string]string{screenshotService: "observe", hidService: "act", appService: "launch", inventoryService: "installedApps"} {
		entry := s.services.Services[service]
		delete(s.services.Services, service)
		data, _ := json.Marshal(s.capabilities())
		var capabilities map[string]interface{}
		_ = json.Unmarshal(data, &capabilities)
		if capabilities[operation] != "native-service-missing" {
			t.Fatalf("missing %s did not disable %s", service, operation)
		}
		if operation != "observe" && capabilities["observe"] != nil {
			t.Fatal("an unrelated service disabled screenshots")
		}
		s.services.Services[service] = entry
	}
	p.sessionID = "setup"
	p.binding = "binding"
	if err := m.closeSession("binding", "setup"); err != nil {
		t.Fatal(err)
	}
	assert("")
	s.services.Udid = "wrong-peer"
	if got := assert("")["capabilities"].(map[string]interface{})["observe"]; got != "identity-mismatch" {
		t.Fatalf("wrong runtime peer: %v", got)
	}
	for _, r := range []wire.Reason{wire.Unsupported, wire.UnsupportedIOS, wire.OwnedElsewhere, wire.USBMuxUnavailable} {
		p.readinessReason = r
		assert(string(r))
	}
	p.readinessReason = wire.TrustRequired
	assert("")
}

type delayedOpenUSB struct {
	fakeUSB
	entered chan struct{}
	resume  chan struct{}
	session *Session
}

func (f *delayedOpenUSB) Open(_ context.Context, request context.Context, _ ios.DeviceEntry) (*Session, error) {
	close(f.entered)
	select {
	case <-f.resume:
		return f.session, nil
	case <-request.Done():
		return nil, request.Err()
	}
}

func TestCloseDuringOpenCannotLeaveAnActiveSession(t *testing.T) {
	m := newTestManager(t)
	d := ios.DeviceEntry{DeviceID: 1, Properties: ios.DeviceProperties{SerialNumber: "opening-fixture", ConnectionType: "USB"}}
	m.inventory.Replace([]ios.DeviceEntry{d})
	if err := m.reconcile(); err != nil {
		t.Fatal(err)
	}
	p := m.phones[m.identities[d.Properties.SerialNumber]]
	p.binding = "binding"
	usb := &delayedOpenUSB{entered: make(chan struct{}), resume: make(chan struct{}), session: &Session{}}
	m.usb = usb
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() {
		_, err := m.open(ctx, &wire.SessionParams{BindingToken: "binding", SessionID: "session", RunID: "run", Access: "observe"})
		done <- err
	}()
	select {
	case <-usb.entered:
	case <-ctx.Done():
		t.Fatal("transport open did not start")
	}
	if err := m.closeSession("binding", "session"); err != nil {
		t.Fatal(err)
	}
	close(usb.resume)
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("canceled native open succeeded")
		}
	case <-ctx.Done():
		t.Fatal("canceled native open did not finish")
	}
	m.mu.Lock()
	active := p.sessionID
	m.mu.Unlock()
	if active != "" {
		t.Fatal("close left an active session")
	}
}

func TestDisplayCapabilitiesFollowServicesAndPrivacyState(t *testing.T) {
	rotation := 0
	s := &Session{
		identity: "fixture", announced: true, mediaAvailable: true,
		state:    DeviceState{Lock: "unlocked", Display: "on", Rotation: &rotation},
		services: ios.RsdHandshakeResponse{Udid: "fixture", Services: map[string]ios.RsdServiceEntry{}},
	}
	for _, name := range []string{deviceInfoService, hidService, pasteboardService, deviceHubAXService, DisplayService} {
		s.services.Services[name] = ios.RsdServiceEntry{Port: 1000}
	}
	caps := s.capabilities()
	if caps.Text != nil || caps.Clear != nil || caps.IndexedTargets != nil || caps.LiveVideo != nil || caps.Wake != nil {
		t.Fatalf("present services with an unlocked display reported a blocker: %+v", caps)
	}
	delete(s.services.Services, pasteboardService)
	caps = s.capabilities()
	if caps.Text == nil || *caps.Text != wire.ServiceMissing || caps.Clear != nil {
		t.Fatal("missing pasteboard also disabled clear, or text advertised full availability")
	}
	s.state.Display = "off"
	s.state.Lock = "locked"
	caps = s.capabilities()
	if caps.Wake != nil || caps.LiveVideo == nil || *caps.LiveVideo != wire.PhoneLocked {
		t.Fatal("capabilities do not admit wake while withholding locked content")
	}
}
