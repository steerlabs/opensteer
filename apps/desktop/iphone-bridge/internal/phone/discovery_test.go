package phone

import (
	"context"
	"encoding/json"
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
func (f *fakeUSB) Pair(context.Context, ios.DeviceEntry) error { panic("unexpected pairing") }
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
