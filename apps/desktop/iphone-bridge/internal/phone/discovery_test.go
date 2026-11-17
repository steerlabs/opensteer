package phone

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/danielpaulus/go-ios/ios"
	"github.com/steerlabs/opensteer/iphone-bridge/internal/wire"
)

type fakeUSB struct {
	events   chan ios.AttachedMessage
	list     []ios.DeviceEntry
	listened chan struct{}
}
type fakeListener struct {
	ctx    context.Context
	events chan ios.AttachedMessage
}

func (l fakeListener) Next() (ios.AttachedMessage, error) {
	select {
	case e := <-l.events:
		return e, nil
	case <-l.ctx.Done():
		return ios.AttachedMessage{}, l.ctx.Err()
	}
}
func (l fakeListener) Close() error { return nil }
func (f *fakeUSB) Listen(ctx context.Context) (MuxListener, error) {
	close(f.listened)
	return fakeListener{ctx, f.events}, nil
}
func (f *fakeUSB) List(context.Context) ([]ios.DeviceEntry, error) {
	select {
	case <-f.listened:
	default:
		panic("list before listen")
	}
	return f.list, nil
}
func (f *fakeUSB) Pair(context.Context, ios.DeviceEntry, *ios.PairingAttempt) error {
	panic("unexpected pairing")
}
func (f *fakeUSB) Inspect(context.Context, ios.DeviceEntry) (Inspection, error) {
	panic("unexpected inspect")
}
func (f *fakeUSB) Open(context.Context, context.Context, ios.DeviceEntry) (*Session, error) {
	panic("unexpected transport")
}
func TestDiscoveryUsesOpaquePersistentIdentityAndDetachMuxID(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	usb := &fakeUSB{events: make(chan ios.AttachedMessage, 4), listened: make(chan struct{}), list: []ios.DeviceEntry{{DeviceID: 1, Properties: ios.DeviceProperties{SerialNumber: "SENTINEL_PRIVATE_PHYSICAL_ID", ConnectionType: "USB"}}, {DeviceID: 2, Properties: ios.DeviceProperties{SerialNumber: "SENTINEL_PRIVATE_PHYSICAL_ID", ConnectionType: "Network"}}}}
	updates := make(chan wire.Roster, 4)
	manager := NewManager(ctx, usb, func(r wire.Roster) { updates <- r })
	defer manager.Close()
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(root, 0700); err != nil {
		t.Fatal(err)
	}
	params, _ := json.Marshal(wire.InitParams{PrivateRoot: root, ImageRoots: []string{}})
	if _, err := manager.Call(ctx, wire.Request{Method: "init", Params: params}); err != nil {
		t.Fatal(err)
	}
	result, err := manager.Call(ctx, wire.Request{Method: "roster.subscribe", Params: json.RawMessage(`{}`)})
	if err != nil {
		t.Fatal(err)
	}
	roster := result.(wire.Roster)
	if len(roster.Candidates) != 1 {
		t.Fatalf("duplicate USB/network candidates: %+v", roster)
	}
	data, _ := json.Marshal(roster)
	if strings.Contains(string(data), "SENTINEL") {
		t.Fatal("physical identity escaped")
	}
	select {
	case <-updates:
	case <-ctx.Done():
		t.Fatal("initial snapshot missing")
	}
	usb.events <- ios.AttachedMessage{MessageType: "Detached", DeviceID: 1}
	select {
	case r := <-updates:
		if len(r.Candidates) != 0 {
			t.Fatal("detach required missing UDID")
		}
	case <-ctx.Done():
		t.Fatal("detach not published")
	}
	usb.events <- ios.AttachedMessage{MessageType: "Attached", DeviceID: 3, Properties: ios.DeviceProperties{SerialNumber: "SENTINEL_PRIVATE_PHYSICAL_ID", ConnectionType: "USB"}}
	select {
	case r := <-updates:
		if len(r.Candidates) != 1 || r.Candidates[0].LocalPhoneID != roster.Candidates[0].LocalPhoneID || r.Candidates[0].NativeEpoch <= roster.Candidates[0].NativeEpoch {
			t.Fatal("replug changed identity or reused epoch")
		}
	case <-ctx.Done():
		t.Fatal("reattach not published")
	}
}

type passiveUSB struct{ fakeUSB }

func (f *passiveUSB) PassiveInspect(ctx context.Context, d ios.DeviceEntry) (Inspection, error) {
	if d.DeviceID == 3 {
		return Inspection{}, wire.Fail(wire.TrustRequired)
	}
	return Inspection{Pairing: "paired", Name: "Known phone", Model: "iPhoneTest", OSVersion: "27.1"}, nil
}
func TestColdRosterPassivelyIdentifiesTrustedPhones(t *testing.T) {
	m := newTestManager(t)
	m.usb = &passiveUSB{}
	devices := []ios.DeviceEntry{}
	for id := 1; id <= 3; id++ {
		devices = append(devices, ios.DeviceEntry{DeviceID: id, Properties: ios.DeviceProperties{SerialNumber: fmt.Sprint(id), ConnectionType: "USB"}})
	}
	m.inventory.Replace(devices)
	if err := m.reconcile(); err != nil {
		t.Fatal(err)
	}
	r := m.roster()
	trusted := 0
	for _, c := range r.Candidates {
		if c.Trusted {
			trusted++
			if c.Name != "Known phone" || c.Model != "iPhoneTest" || c.OSVersion != "27.1" {
				t.Fatal("trusted candidate missing identity")
			}
		} else if c.Name != "iPhone" || c.Model != "" {
			t.Fatal("untrusted phone was identified")
		}
	}
	if trusted != 2 {
		t.Fatalf("cold discovery identified %d trusted phones", trusted)
	}
	devices[0].DeviceID = 4
	m.inventory.Replace(devices)
	if err := m.reconcile(); err != nil {
		t.Fatal(err)
	}
	trusted = 0
	for _, c := range m.roster().Candidates {
		if c.Trusted {
			trusted++
		}
	}
	if trusted != 2 {
		t.Fatal("route replacement erased trusted identity")
	}
}

type pendingPairUSB struct {
	fakeUSB
	attempts []*ios.PairingAttempt
}

func (f *pendingPairUSB) Pair(_ context.Context, _ ios.DeviceEntry, attempt *ios.PairingAttempt) error {
	f.attempts = append(f.attempts, attempt)
	if len(f.attempts) == 3 {
		return nil
	}
	return wire.Fail(wire.TrustPending)
}
func TestPendingPairIdentityLivesUntilAcceptanceOrRelease(t *testing.T) {
	m := newTestManager(t)
	usb := &pendingPairUSB{}
	m.usb = usb
	d := ios.DeviceEntry{DeviceID: 1, Properties: ios.DeviceProperties{SerialNumber: "pair-fixture", ConnectionType: "USB"}}
	m.inventory.Replace([]ios.DeviceEntry{d})
	if err := m.reconcile(); err != nil {
		t.Fatal(err)
	}
	p := m.phones[m.identities["pair-fixture"]]
	pair := func() {
		t.Helper()
		params, _ := json.Marshal(wire.PhoneRef{LocalPhoneID: p.id, NativeEpoch: p.epoch})
		_, _ = m.Call(context.Background(), wire.Request{Method: "setup.pair", Params: params})
	}
	pair()
	pair()
	pair()
	if len(usb.attempts) != 3 || usb.attempts[0] != usb.attempts[1] || usb.attempts[0] != usb.attempts[2] {
		t.Fatal("Trust retries replaced pending identity")
	}
	if p.pairing != nil {
		t.Fatal("accepted attempt retained private identity")
	}
	pair()
	if p.pairing == nil || p.pairing == usb.attempts[0] {
		t.Fatal("later setup reused accepted identity")
	}
	p.binding = "pending-binding"
	if err := m.release(p.binding, true); err != nil {
		t.Fatal(err)
	}
	if p.pairing != nil {
		t.Fatal("cancelled setup retained private identity")
	}
}
