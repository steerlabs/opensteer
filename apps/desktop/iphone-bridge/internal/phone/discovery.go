package phone

import (
	"context"
	"sync"
	"time"

	"github.com/danielpaulus/go-ios/ios"
	"github.com/steerlabs/opensteer/iphone-bridge/internal/wire"
)

type MuxListener interface {
	Next() (ios.AttachedMessage, error)
	Close() error
}
type USB interface {
	Listen(context.Context) (MuxListener, error)
	List(context.Context) ([]ios.DeviceEntry, error)
	Pair(context.Context, ios.DeviceEntry) error
	Inspect(context.Context, ios.DeviceEntry) (Inspection, error)
	Open(context.Context, context.Context, ios.DeviceEntry) (*Session, error)
}
type SystemUSB struct{}
type systemListener struct {
	next func() (ios.AttachedMessage, error)
	mux  *ios.UsbMuxConnection
}

func (l *systemListener) Next() (ios.AttachedMessage, error) { return l.next() }
func (l *systemListener) Close() error                       { return l.mux.Close() }
func (SystemUSB) Listen(ctx context.Context) (MuxListener, error) {
	m, err := ios.NewUsbMuxConnectionContext(ctx)
	if err != nil {
		return nil, Classify(err, wire.USBMuxUnavailable)
	}
	_ = m.SetDeadline(time.Now().Add(5 * time.Second))
	next, err := m.Listen()
	if err != nil {
		_ = m.Close()
		return nil, Classify(err, wire.USBMuxUnavailable)
	}
	_ = m.SetDeadline(time.Time{})
	return &systemListener{next, m}, nil
}
func (SystemUSB) List(ctx context.Context) ([]ios.DeviceEntry, error) {
	m, err := ios.NewUsbMuxConnectionContext(ctx)
	if err != nil {
		return nil, Classify(err, wire.USBMuxUnavailable)
	}
	defer m.Close()
	list, err := m.ListDevices()
	if err != nil {
		return nil, Classify(err, wire.USBMuxUnavailable)
	}
	if len(list.DeviceList) > 64 {
		return nil, wire.Fail(wire.USBMuxUnavailable)
	}
	return list.DeviceList, nil
}
func (SystemUSB) Pair(ctx context.Context, d ios.DeviceEntry) error {
	d.Context = ctx
	return ClassifyOrNil(ios.Pair(d), wire.PairingFailed)
}
func (SystemUSB) Open(lifetime, request context.Context, d ios.DeviceEntry) (*Session, error) {
	inspection, err := (SystemUSB{}).Inspect(request, d)
	if err != nil {
		return nil, err
	}
	if inspection.DeveloperMode != "enabled" {
		if inspection.DeveloperMode == "unknown" {
			return nil, wire.Fail(wire.DeveloperModeUnknown)
		}
		return nil, wire.Fail(wire.DeveloperModeRequired)
	}
	return OpenSession(lifetime, request, d)
}
func ClassifyOrNil(err error, fallback wire.Reason) error {
	if err == nil {
		return nil
	}
	return Classify(err, fallback)
}

type Inventory struct {
	mu     sync.Mutex
	routes map[int]ios.DeviceEntry
}

func (i *Inventory) Replace(devices []ios.DeviceEntry) {
	i.mu.Lock()
	defer i.mu.Unlock()
	i.routes = make(map[int]ios.DeviceEntry)
	for _, d := range devices {
		i.add(d)
	}
}
func (i *Inventory) add(d ios.DeviceEntry) {
	if d.DeviceID > 0 && d.Properties.SerialNumber != "" && len(d.Properties.SerialNumber) <= 128 && (d.Properties.ConnectionType == "USB" || d.Properties.ConnectionType == "Network") && len(i.routes) < 64 {
		i.routes[d.DeviceID] = d
	}
}
func (i *Inventory) Apply(event ios.AttachedMessage) {
	i.mu.Lock()
	defer i.mu.Unlock()
	if i.routes == nil {
		i.routes = make(map[int]ios.DeviceEntry)
	}
	if event.DeviceDetached() {
		delete(i.routes, event.DeviceID)
	} else if event.DeviceAttached() {
		i.add(event.DeviceEntry())
	}
}
func (i *Inventory) USBDevices() []ios.DeviceEntry {
	i.mu.Lock()
	defer i.mu.Unlock()
	byIdentity := make(map[string]ios.DeviceEntry)
	for _, d := range i.routes {
		if d.Properties.ConnectionType == "USB" {
			byIdentity[d.Properties.SerialNumber] = d
		}
	}
	result := make([]ios.DeviceEntry, 0, len(byIdentity))
	for _, d := range byIdentity {
		result = append(result, d)
	}
	return result
}
