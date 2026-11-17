package phone

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net"
	"net/netip"
	"os"
	"path/filepath"
	"strconv"
	"syscall"
	"testing"
	"time"

	"github.com/danielpaulus/go-ios/ios"
	"github.com/danielpaulus/go-ios/ios/tunnel"
	"github.com/steerlabs/opensteer/iphone-bridge/internal/wire"
)

func TestNetworkRoutesDeduplicateAndPreferUSB(t *testing.T) {
	var inventory Inventory
	network := ios.DeviceEntry{DeviceID: 4, Properties: ios.DeviceProperties{SerialNumber: "test-only-phone", ConnectionType: "Network"}}
	usb := network
	usb.DeviceID = 7
	usb.Properties.ConnectionType = "USB"
	inventory.Replace([]ios.DeviceEntry{network, usb})
	routes := inventory.PreferredDevices(nil)
	if len(routes) != 1 || routes[0].DeviceID != 7 {
		t.Fatal("USB did not win duplicate identity")
	}
	inventory.Apply(ios.AttachedMessage{DeviceID: 7, MessageType: "Detached"})
	routes = inventory.PreferredDevices(map[string]bool{"test-only-phone": true})
	if len(routes) != 1 || routes[0].DeviceID != 4 {
		t.Fatal("network route did not preserve physical identity")
	}
	if len(inventory.PreferredDevices(nil)) != 0 {
		t.Fatal("network route admitted without explicit Wi-Fi preference")
	}
}

func TestTransportSwitchCancelsOutstandingWork(t *testing.T) {
	m := newTestManager(t)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	d := ios.DeviceEntry{DeviceID: 1, Properties: ios.DeviceProperties{SerialNumber: "switch-test", ConnectionType: "USB"}}
	m.inventory.Replace([]ios.DeviceEntry{d})
	if err := m.reconcile(); err != nil {
		t.Fatal(err)
	}
	r := m.roster().Candidates[0]
	entered := make(chan struct{})
	result := make(chan error, 1)
	go func() {
		_, err := m.withPhone(context.Background(), wire.PhoneRef{LocalPhoneID: r.LocalPhoneID, NativeEpoch: r.NativeEpoch}, func(ctx context.Context, p *localPhone) (interface{}, error) {
			close(entered)
			<-ctx.Done()
			return nil, ctx.Err()
		})
		result <- err
	}()
	select {
	case <-entered:
	case <-ctx.Done():
		t.Fatal("work did not enter route")
	}
	d.DeviceID = 2
	d.Properties.ConnectionType = "Network"
	m.wifi["switch-test"] = wirelessState{Enabled: true}
	m.inventory.Replace([]ios.DeviceEntry{d})
	if err := m.reconcile(); err != nil {
		t.Fatal(err)
	}
	var resultErr error
	select {
	case resultErr = <-result:
	case <-ctx.Done():
		t.Fatal("transport switch did not cancel work")
	}
	if resultErr == nil {
		t.Fatal("old work survived switch")
	}
	next := m.roster().Candidates[0]
	if next.LocalPhoneID != r.LocalPhoneID || next.NativeEpoch <= r.NativeEpoch || next.Transport != "wifi" {
		t.Fatal("switch changed identity or retained epoch")
	}
	_, err := m.withPhone(context.Background(), wire.PhoneRef{LocalPhoneID: r.LocalPhoneID, NativeEpoch: r.NativeEpoch}, func(context.Context, *localPhone) (interface{}, error) {
		t.Fatal("old observation admitted")
		return nil, nil
	})
	if err == nil {
		t.Fatal("stale observation survived")
	}
}

func newTestManager(t *testing.T) *Manager {
	t.Helper()
	m := NewManager(context.Background(), &fakeUSB{}, nil)
	t.Cleanup(func() { _ = m.Close() })
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(root, 0700); err != nil {
		t.Fatal(err)
	}
	data, _ := json.Marshal(wire.InitParams{PrivateRoot: root, ImageRoots: []string{}})
	if _, err := m.Call(context.Background(), wire.Request{Method: "init", Params: data}); err != nil {
		t.Fatal(err)
	}
	return m
}

type wifiUSB struct {
	fakeUSB
	enabled  bool
	writes   []bool
	writeErr error
	opened   int
}

func (f *wifiUSB) WifiSetting(context.Context, ios.DeviceEntry) (bool, error) { return f.enabled, nil }
func (f *wifiUSB) SetWifiSetting(_ context.Context, _ ios.DeviceEntry, v bool) error {
	f.writes = append(f.writes, v)
	if f.writeErr != nil {
		return f.writeErr
	}
	f.enabled = v
	return nil
}
func (f *wifiUSB) Inspect(context.Context, ios.DeviceEntry) (Inspection, error) {
	return Inspection{DeveloperMode: "enabled"}, nil
}
func (f *wifiUSB) Open(context.Context, context.Context, ios.DeviceEntry) (*Session, error) {
	f.opened++
	return &Session{}, nil
}

func TestWifiSetupReusesVerifiedIdleTransport(t *testing.T) {
	m := newTestManager(t)
	usb := &wifiUSB{}
	m.usb = usb
	id := "idle-wifi-fixture"
	m.inventory.Replace([]ios.DeviceEntry{{DeviceID: 1, Properties: ios.DeviceProperties{SerialNumber: id, ConnectionType: "USB"}}})
	if err := m.reconcile(); err != nil {
		t.Fatal(err)
	}
	p := m.phones[m.identities[id]]
	p.session = &Session{identity: id, announced: true, services: ios.RsdHandshakeResponse{Udid: id}}
	if _, err := m.wifiSetup(context.Background(), p, "setup.enableWifi"); err != nil {
		t.Fatal(err)
	}
	if usb.opened != 0 {
		t.Fatal("Wi-Fi setup created a second RSD session beside the verified idle transport")
	}
}
func TestWifiSettingRestoresOnlyAppChangeAndCanRetry(t *testing.T) {
	for _, previous := range []bool{false, true} {
		t.Run(strconv.FormatBool(previous), func(t *testing.T) {
			m := newTestManager(t)
			usb := &wifiUSB{enabled: previous}
			m.usb = usb
			d := ios.DeviceEntry{DeviceID: 1, Properties: ios.DeviceProperties{SerialNumber: "settings-fixture", ConnectionType: "USB"}}
			m.inventory.Replace([]ios.DeviceEntry{d})
			if err := m.reconcile(); err != nil {
				t.Fatal(err)
			}
			p := m.phones[m.identities["settings-fixture"]]
			if _, err := m.wifiSetup(context.Background(), p, "setup.enableWifi"); err != nil {
				t.Fatal(err)
			}
			if !usb.enabled {
				t.Fatal("explicit enable did not enable")
			}
			if _, err := m.wifiSetup(context.Background(), p, "setup.disableWifi"); err != nil {
				t.Fatal(err)
			}
			if usb.enabled != previous {
				t.Fatal("previous setting was not preserved")
			}
			if previous && len(usb.writes) != 0 {
				t.Fatal("changed a setting inherited from Xcode/person")
			}
		})
	}
	m := newTestManager(t)
	usb := &wifiUSB{writeErr: wire.Fail(wire.WifiTransportUnsupported)}
	m.usb = usb
	d := ios.DeviceEntry{DeviceID: 1, Properties: ios.DeviceProperties{SerialNumber: "retry-fixture", ConnectionType: "USB"}}
	m.inventory.Replace([]ios.DeviceEntry{d})
	if err := m.reconcile(); err != nil {
		t.Fatal(err)
	}
	p := m.phones[m.identities["retry-fixture"]]
	if _, err := m.wifiSetup(context.Background(), p, "setup.enableWifi"); err == nil {
		t.Fatal("failed setting reported success")
	}
	usb.writeErr = nil
	if _, err := m.wifiSetup(context.Background(), p, "setup.enableWifi"); err != nil {
		t.Fatal(err)
	}
	if !usb.enabled {
		t.Fatal("explicit retry lost the unfinished setting change")
	}
	if err := m.loadWifi(); err != nil {
		t.Fatal(err)
	}
	if !m.wifi[p.identity].Changed {
		t.Fatal("retry lost restoration ownership")
	}
}
func TestCableInsertionPreservesHealthySessionThenPrefersUSB(t *testing.T) {
	m := newTestManager(t)
	id := "active-wifi-fixture"
	m.wifi[id] = wirelessState{Enabled: true}
	d := ios.DeviceEntry{DeviceID: 2, Properties: ios.DeviceProperties{SerialNumber: id, ConnectionType: "Network"}}
	m.inventory.Replace([]ios.DeviceEntry{d})
	if err := m.reconcile(); err != nil {
		t.Fatal(err)
	}
	p := m.phones[m.identities[id]]
	p.session = &Session{}
	p.sessionID = "active"
	epoch := p.epoch
	usb := d
	usb.DeviceID = 3
	usb.Properties.ConnectionType = "USB"
	m.inventory.Apply(ios.AttachedMessage{MessageType: "Attached", DeviceID: 3, Properties: usb.Properties})
	if err := m.reconcile(); err != nil {
		t.Fatal(err)
	}
	if p.entry.DeviceID != 2 || p.epoch != epoch {
		t.Fatal("cable insertion interrupted healthy Wi-Fi session")
	}
	p.session.Close()
	p.session = nil
	p.sessionID = ""
	if err := m.reconcile(); err != nil {
		t.Fatal(err)
	}
	if p.entry.DeviceID != 3 || p.epoch <= epoch {
		t.Fatal("new session did not prefer USB")
	}
}

type routeUSB struct {
	fakeUSB
	err      error
	opened   int
	deviceID int
}

func (f *routeUSB) Open(_ context.Context, _ context.Context, d ios.DeviceEntry) (*Session, error) {
	f.opened++
	f.deviceID = d.DeviceID
	if f.err != nil {
		return nil, f.err
	}
	return &Session{}, nil
}
func TestSystemNetworkRouteProbesBeforeDirectAndIdentityFailureNeverDowngrades(t *testing.T) {
	m := newTestManager(t)
	usb := &routeUSB{}
	m.usb = usb
	id := "system-route-fixture"
	m.wifi[id] = wirelessState{Enabled: true}
	d := ios.DeviceEntry{DeviceID: 12, Properties: ios.DeviceProperties{SerialNumber: id, ConnectionType: "Network"}}
	m.inventory.Replace([]ios.DeviceEntry{d})
	if err := m.reconcile(); err != nil {
		t.Fatal(err)
	}
	p := m.phones[m.identities[id]]
	m.browse = func(context.Context) ([]NetworkCandidate, error) {
		t.Fatal("direct backend ran alongside working system route")
		return nil, nil
	}
	s, err := m.openTransport(context.Background(), context.Background(), p)
	if err != nil {
		t.Fatal(err)
	}
	s.Close()
	if usb.opened != 1 || usb.deviceID != 12 {
		t.Fatal("concrete Network mux entry was not used")
	}
	usb.err = wire.Fail(wire.IdentityMismatch)
	if _, err := m.openTransport(context.Background(), context.Background(), p); networkFailure(err).Code != wire.WifiIdentityMismatch {
		t.Fatal("identity mismatch was not terminal")
	}
	usb.err = wire.Fail(wire.DeveloperModeRequired)
	if _, err := m.openTransport(context.Background(), context.Background(), p); networkFailure(err).Code != wire.DeveloperModeRequired {
		t.Fatal("direct transport bypassed developer-mode refusal")
	}
	usb.err = wire.Fail(wire.TunnelFailed)
	if _, err := m.openTransport(context.Background(), context.Background(), p); networkFailure(err).Code != wire.WifiPairingRequired {
		t.Fatal("missing direct pairing did not produce setup reason")
	}
}

func TestWifiDisablePreemptsQueuedWorkAndOfflineRestoreRunsOnUSBReturn(t *testing.T) {
	m := newTestManager(t)
	usb := &wifiUSB{enabled: true}
	m.usb = usb
	id := "disable-fixture"
	m.wifi[id] = wirelessState{Enabled: true, Changed: true, Previous: false}
	d := ios.DeviceEntry{DeviceID: -1, Properties: ios.DeviceProperties{SerialNumber: id, ConnectionType: "Network"}}
	if err := m.reconcile(); err != nil {
		t.Fatal(err)
	}
	p := m.phones[m.identities[id]]
	ref := wire.PhoneRef{LocalPhoneID: p.id, NativeEpoch: p.epoch}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	started := make(chan struct{})
	settled := make(chan error, 1)
	go func() {
		_, err := m.withPhone(ctx, ref, func(ctx context.Context, _ *localPhone) (interface{}, error) {
			close(started)
			<-ctx.Done()
			return nil, ctx.Err()
		})
		settled <- err
	}()
	select {
	case <-started:
	case <-ctx.Done():
		t.Fatal("work did not start")
	}
	params, _ := json.Marshal(ref)
	_, err := m.Call(ctx, wire.Request{Method: "setup.disableWifi", Params: params})
	if networkFailure(err).Code != wire.WifiPhoneNotFound {
		t.Fatalf("offline restoration was not deferred: %v", err)
	}
	select {
	case err := <-settled:
		if err == nil {
			t.Fatal("old work was not canceled")
		}
	case <-ctx.Done():
		t.Fatal("disable did not preempt queued work")
	}
	if m.wifi[id].Enabled || !m.wifi[id].Changed {
		t.Fatal("offline disable lost restoration intent")
	}
	d.DeviceID = 3
	d.Properties.ConnectionType = "USB"
	m.inventory.Replace([]ios.DeviceEntry{d})
	if err := m.reconcile(); err != nil {
		t.Fatal(err)
	}
	restored := make(chan struct{})
	go func() { m.wg.Wait(); close(restored) }()
	select {
	case <-restored:
	case <-ctx.Done():
		t.Fatal("USB return did not settle setting restoration")
	}
	if usb.enabled || m.wifi[id].Changed {
		t.Fatal("USB return did not restore the previous setting")
	}
}
func TestWifiPairingStateIsPrivateAndMalformedStoreFailsClosed(t *testing.T) {
	m := newTestManager(t)
	id := "private-state-fixture"
	record := &tunnel.RemotePairRecord{UDID: id, HostIdentifier: "test-host", HostSeed: make([]byte, 32), HostIRK: make([]byte, 16), PeerIdentifier: "test-peer", PeerPublicKey: make([]byte, 32), PeerIRK: make([]byte, 16)}
	m.wifi[id] = wirelessState{Enabled: true, Pair: record}
	if err := m.saveWifi(); err != nil {
		t.Fatal(err)
	}
	if err := m.loadWifi(); err != nil {
		t.Fatal(err)
	}
	if m.wifi[id].Pair.UDID != id {
		t.Fatal("private pairing identity lost")
	}
	info, err := m.root.Stat("wifi.v1.json")
	if err != nil || !privateFile(info) {
		t.Fatal("pairing state was not private")
	}
	if err := os.Chmod(filepath.Join(m.rootPath, "wifi.v1.json"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := m.loadWifi(); err == nil {
		t.Fatal("readable-by-others pairing file was admitted")
	}
}

func TestWithdrawWifiPersistsOfflineRestoreAndRemovesAdmission(t *testing.T) {
	m := newTestManager(t)
	usb := &wifiUSB{enabled: true}
	m.usb = usb
	id := "withdraw-fixture"
	m.wifi[id] = wirelessState{Enabled: true, Changed: true, Previous: false}
	owner := wire.ForgetBindingParams{UDID: id, DeploymentID: "deployment", HostInstanceID: "host", RunnerID: "runner", DeviceID: "device", DriverGeneration: 1}
	params, _ := json.Marshal(owner)
	if _, err := m.Call(context.Background(), wire.Request{Method: "setup.withdrawWifi", Params: params}); err != nil {
		t.Fatal(err)
	}
	if err := m.loadWifi(); err != nil {
		t.Fatal(err)
	}
	if err := m.forgetPrivateBinding(&owner); err != nil {
		t.Fatal(err)
	}
	if m.wifi[id].Enabled || !m.wifi[id].Changed || len(m.roster().Candidates) != 0 {
		t.Fatal("offline withdrawal did not retain restoration without admission")
	}
	d := ios.DeviceEntry{DeviceID: 1, Properties: ios.DeviceProperties{SerialNumber: id, ConnectionType: "USB"}}
	m.inventory.Replace([]ios.DeviceEntry{d})
	if err := m.reconcile(); err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	go func() { m.wg.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("USB return did not restore the setting")
	}
	if usb.enabled || m.wifi[id].Changed {
		t.Fatal("pending restoration was lost")
	}
}

func TestWifiWithdrawalCannotChangeAnotherDeploymentsPreference(t *testing.T) {
	m := newTestManager(t)
	id := "owned-wifi-fixture"
	m.wifi[id] = wirelessState{Enabled: true, Changed: true}
	owner := Owner{"deployment", "host", "runner", "device", 1}
	reservation, err := Reserve(m.root, id, owner)
	if err != nil {
		t.Fatal(err)
	}
	_ = reservation.Close()
	err = m.withdrawWifi(context.Background(), &wire.ForgetBindingParams{UDID: id, DeploymentID: "other-deployment", HostInstanceID: owner.HostInstanceID, RunnerID: owner.RunnerID, DeviceID: owner.DeviceID, DriverGeneration: owner.DriverGeneration})
	failure(t, err, wire.OwnedElsewhere, "not-started")
	if !m.wifi[id].Enabled {
		t.Fatal("another Deployment withdrew Wi-Fi admission")
	}
}

func TestDirectAdapterRunsOnlyAfterSystemProbeFails(t *testing.T) {
	m := newTestManager(t)
	usb := &routeUSB{err: wire.Fail(wire.TunnelFailed)}
	m.usb = usb
	id := "direct-probe-fixture"
	record := &tunnel.RemotePairRecord{UDID: id, HostIdentifier: "test-host", HostSeed: make([]byte, 32), HostIRK: make([]byte, 16), PeerIdentifier: "test-peer", PeerPublicKey: make([]byte, 32), PeerIRK: make([]byte, 16)}
	m.wifi[id] = wirelessState{Enabled: true, Pair: record}
	d := ios.DeviceEntry{DeviceID: 23, Properties: ios.DeviceProperties{SerialNumber: id, ConnectionType: "Network"}}
	m.inventory.Replace([]ios.DeviceEntry{d})
	if err := m.reconcile(); err != nil {
		t.Fatal(err)
	}
	browsed, dialed := false, false
	c := NetworkCandidate{Instance: "fixture", Identifier: "direct-probe", Address: netip.MustParseAddr("192.0.2.8"), Port: 1234, Interface: testLAN(), Expires: time.Now().Add(time.Minute)}
	c.AuthTag = base64.StdEncoding.EncodeToString(remoteAuthTag(record.PeerIRK, c.Identifier))
	m.browse = func(context.Context) ([]NetworkCandidate, error) {
		if usb.opened != 1 {
			t.Fatal("direct ran before system probe")
		}
		browsed = true
		return []NetworkCandidate{c}, nil
	}
	m.interfaces = func() ([]LANInterface, error) { return []LANInterface{testLAN()}, nil }
	m.dial = func(context.Context, NetworkCandidate, uint16) (net.Conn, error) {
		dialed = true
		return nil, syscall.EACCES
	}
	_, err := m.openTransport(context.Background(), context.Background(), m.phones[m.identities[id]])
	if !browsed || !dialed || networkFailure(err).Code != wire.LocalNetworkPermissionRequired {
		t.Fatal("direct contingency or permission reason missing")
	}
}
