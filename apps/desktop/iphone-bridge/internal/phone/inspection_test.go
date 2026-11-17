package phone

import (
	"context"
	"encoding/json"
	"io"
	"sync"
	"testing"
	"testing/synctest"
	"time"

	"github.com/danielpaulus/go-ios/ios"
	"github.com/steerlabs/opensteer/iphone-bridge/internal/wire"
)

type inspectionUSB struct {
	fakeUSB
	inspect func(context.Context, ios.DeviceEntry) (Inspection, error)
}

func (f *inspectionUSB) PassiveInspect(ctx context.Context, d ios.DeviceEntry) (Inspection, error) {
	return f.inspect(ctx, d)
}
func (f *inspectionUSB) Open(context.Context, context.Context, ios.DeviceEntry) (*Session, error) {
	return &Session{screen: &screenSession{backend: &fixtureScreen{}}}, nil
}
func inspectionDevice(id int) ios.DeviceEntry {
	return ios.DeviceEntry{DeviceID: id, Properties: ios.DeviceProperties{SerialNumber: string(rune('a' + id)), ConnectionType: "USB"}}
}
func awaitInspection[T any](t *testing.T, ctx context.Context, ch <-chan T, message string) T {
	t.Helper()
	select {
	case v := <-ch:
		return v
	case <-ctx.Done():
		t.Fatal(message)
		var zero T
		return zero
	}
}

func TestPassiveInspectionDoesNotBlockOtherSessionOrUSBDetach(t *testing.T) {
	m := newTestManager(t)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	started, stopped := make(chan struct{}), make(chan struct{})
	usb := &inspectionUSB{fakeUSB: fakeUSB{events: make(chan ios.AttachedMessage, 1), listened: make(chan struct{}), list: []ios.DeviceEntry{inspectionDevice(1), inspectionDevice(2)}}}
	usb.inspect = func(ctx context.Context, d ios.DeviceEntry) (Inspection, error) {
		if d.DeviceID == 1 {
			close(started)
			<-ctx.Done()
			close(stopped)
			return Inspection{}, ctx.Err()
		}
		return Inspection{Pairing: "paired", Name: "Other phone"}, nil
	}
	m.usb = usb
	updates := make(chan wire.Roster, 16)
	m.publish = func(r wire.Roster) { updates <- r }
	discovered := make(chan error, 1)
	go func() { discovered <- m.startDiscovery(ctx) }()
	awaitInspection(t, ctx, started, "passive inspection never started")
	r := m.roster()
	var ref wire.PhoneRef
	m.mu.Lock()
	p := m.phones[m.identities[inspectionDevice(2).Properties.SerialNumber]]
	ref = wire.PhoneRef{LocalPhoneID: p.id, NativeEpoch: p.epoch}
	m.mu.Unlock()
	_, err := m.withPhone(ctx, ref, func(_ context.Context, p *localPhone) (interface{}, error) {
		return m.acquire(p, &wire.BindingParams{PhoneRef: ref, DeploymentID: "d", HostInstanceID: "h", RunnerID: "r", DeviceID: "other-phone", DriverGeneration: 1})
	})
	if err != nil {
		t.Fatal(err)
	}
	params, _ := json.Marshal(wire.SessionParams{BindingToken: p.binding, SessionID: "other-session", RunID: "run", Access: "observe"})
	if _, err := m.Call(ctx, wire.Request{Method: "session.open", Params: params}); err != nil {
		t.Errorf("another phone could not open while inspection blocked: %v", err)
	}
	usb.events <- ios.AttachedMessage{MessageType: "Detached", DeviceID: 1}
	for len(r.Candidates) != 1 {
		r = awaitInspection(t, ctx, updates, "USB detach was blocked by passive inspection")
	}
	awaitInspection(t, ctx, stopped, "detach did not cancel inspection")
	if err := awaitInspection(t, ctx, discovered, "discovery did not become ready"); err != nil {
		t.Fatal(err)
	}
}

func TestPassiveInspectionFifthPhoneSurvivesFourTimeouts(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		m := newTestManager(t)
		defer m.Close()
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		var mu sync.Mutex
		stalled := map[int]bool{}
		healthy := make(chan int, 1)
		m.usb = &inspectionUSB{inspect: func(ctx context.Context, d ios.DeviceEntry) (Inspection, error) {
			if ctx.Err() != nil {
				return Inspection{}, ctx.Err()
			}
			mu.Lock()
			if len(stalled) < 4 {
				stalled[d.DeviceID] = true
			}
			slow := stalled[d.DeviceID]
			mu.Unlock()
			if slow {
				<-ctx.Done()
				return Inspection{}, ctx.Err()
			}
			healthy <- d.DeviceID
			return Inspection{Pairing: "paired", Name: "Fifth phone"}, nil
		}}
		m.inventory.Replace([]ios.DeviceEntry{inspectionDevice(1), inspectionDevice(2), inspectionDevice(3), inspectionDevice(4), inspectionDevice(5)})
		if err := m.reconcile(); err != nil {
			t.Fatal(err)
		}
		id := awaitInspection(t, ctx, healthy, "healthy fifth phone was permanently starved")
		synctest.Wait()
		m.mu.Lock()
		p := m.phones[m.identities[inspectionDevice(id).Properties.SerialNumber]]
		trusted := p.inspection.Pairing == "paired" && p.inspection.Name == "Fifth phone"
		m.mu.Unlock()
		if !trusted {
			t.Fatal("fifth phone's bounded attempt did not publish its result")
		}
	})
}

func TestPassiveInspectionBacksOffOnlyUnfinishedCandidates(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		m := newTestManager(t)
		defer m.Close()
		var mu sync.Mutex
		calls := map[int][]time.Time{}
		m.usb = &inspectionUSB{inspect: func(_ context.Context, d ios.DeviceEntry) (Inspection, error) {
			mu.Lock()
			calls[d.DeviceID] = append(calls[d.DeviceID], time.Now())
			n := len(calls[d.DeviceID])
			mu.Unlock()
			if d.DeviceID == 2 {
				return Inspection{}, wire.Fail(wire.TrustRequired)
			}
			if d.DeviceID == 3 && n < 3 {
				return Inspection{}, io.ErrUnexpectedEOF
			}
			metadata := Inspection{Pairing: "paired", Name: "Known phone", Model: "iPhoneFixture", OSVersion: "27.1", Build: "fixture"}
			if d.DeviceID == 1 {
				return metadata, wire.Fail(wire.NativeServiceFailed)
			}
			return metadata, nil
		}}
		m.inventory.Replace([]ios.DeviceEntry{inspectionDevice(1), inspectionDevice(2), inspectionDevice(3)})
		if err := m.reconcile(); err != nil {
			t.Fatal(err)
		}
		synctest.Wait()
		// These timer channels advance synctest's fake clock, not wall time.
		<-time.After(time.Second)
		synctest.Wait()
		<-time.After(2 * time.Second)
		synctest.Wait()
		<-time.After(time.Minute)
		synctest.Wait()
		mu.Lock()
		defer mu.Unlock()
		if len(calls[1]) != 1 || len(calls[2]) != 1 || len(calls[3]) != 3 {
			t.Fatalf("definitive answers retried or transient answer abandoned: %v", calls)
		}
		if calls[3][1].Sub(calls[3][0]) != time.Second || calls[3][2].Sub(calls[3][1]) != 2*time.Second {
			t.Fatal("transient retries did not back off independently")
		}
	})
}

func TestPassiveInspectionFencesAndDrainsRemovedRoute(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		m := newTestManager(t)
		defer m.Close()
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		started, cancelled, release := make(chan struct{}), make(chan struct{}), make(chan struct{})
		calls := 0
		m.usb = &inspectionUSB{inspect: func(attempt context.Context, _ ios.DeviceEntry) (Inspection, error) {
			calls++
			if calls == 1 {
				close(started)
				<-attempt.Done()
				close(cancelled)
				awaitInspection(t, ctx, release, "cancelled inspection was never released")
				return Inspection{Pairing: "paired", Name: "Stale phone"}, nil
			}
			return Inspection{Pairing: "paired", Name: "Fresh phone"}, nil
		}}
		m.inventory.Replace([]ios.DeviceEntry{inspectionDevice(1)})
		if err := m.reconcile(); err != nil {
			t.Fatal(err)
		}
		awaitInspection(t, ctx, started, "inspection never started")
		old := m.roster().Candidates[0]
		m.inventory.Replace(nil)
		removed := make(chan error, 1)
		go func() { removed <- m.reconcile() }()
		awaitInspection(t, ctx, cancelled, "detach did not cancel old route")
		synctest.Wait()
		select {
		case <-removed:
			t.Error("phone removal did not await inspection cleanup")
		default:
		}
		close(release)
		if err := awaitInspection(t, ctx, removed, "phone removal did not finish"); err != nil {
			t.Fatal(err)
		}
		synctest.Wait()
		if len(m.roster().Candidates) != 0 {
			t.Fatal("late result resurrected detached phone")
		}
		m.inventory.Replace([]ios.DeviceEntry{inspectionDevice(1)})
		if err := m.reconcile(); err != nil {
			t.Fatal(err)
		}
		synctest.Wait()
		next := m.roster().Candidates[0]
		if next.LocalPhoneID != old.LocalPhoneID || next.NativeEpoch <= old.NativeEpoch || next.Name != "Fresh phone" {
			t.Fatal("reattach reused the old route's identity result")
		}
		m.inventory.Replace(nil)
		if err := m.reconcile(); err != nil {
			t.Fatal(err)
		}
		<-time.After(time.Minute)
		synctest.Wait()
		if calls != 2 {
			t.Fatal("detached phone was retried")
		}
	})
}

func TestPassiveInspectionYieldsToSetupAndSession(t *testing.T) {
	for _, operation := range []string{"setup", "session"} {
		t.Run(operation, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				m := newTestManager(t)
				defer m.Close()
				ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
				defer cancel()
				m.inventory.Replace([]ios.DeviceEntry{inspectionDevice(1)})
				if err := m.reconcile(); err != nil {
					t.Fatal(err)
				}
				p := m.phones[m.identities[inspectionDevice(1).Properties.SerialNumber]]
				entered, release, returned := make(chan struct{}), make(chan struct{}), make(chan error, 1)
				if operation == "setup" {
					go func() {
						_, err := m.withPhone(ctx, wire.PhoneRef{LocalPhoneID: p.id, NativeEpoch: p.epoch}, func(context.Context, *localPhone) (interface{}, error) {
							close(entered)
							awaitInspection(t, ctx, release, "setup was never released")
							return nil, nil
						})
						returned <- err
					}()
					awaitInspection(t, ctx, entered, "setup operation did not start")
				} else {
					p.binding, p.sessionID = "binding", "session"
				}
				inspected := make(chan struct{}, 1)
				m.usb = &inspectionUSB{inspect: func(context.Context, ios.DeviceEntry) (Inspection, error) {
					inspected <- struct{}{}
					return Inspection{Pairing: "paired", Name: "Ready phone"}, nil
				}}
				if err := m.reconcile(); err != nil {
					t.Fatal(err)
				}
				synctest.Wait()
				select {
				case <-inspected:
					t.Fatal("passive inspection interfered with " + operation)
				default:
				}
				if operation == "setup" {
					close(release)
					if err := awaitInspection(t, ctx, returned, "setup never finished"); err != nil {
						t.Fatal(err)
					}
				} else if err := m.closeSession("binding", "session"); err != nil {
					t.Fatal(err)
				}
				awaitInspection(t, ctx, inspected, "idle phone was not inspected after "+operation)
			})
		})
	}
}

func TestManagerCloseCancelsAndAwaitsPassiveInspection(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		m := newTestManager(t)
		defer m.Close()
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		started, cancelled, release := make(chan struct{}), make(chan struct{}), make(chan struct{})
		m.usb = &inspectionUSB{inspect: func(attempt context.Context, _ ios.DeviceEntry) (Inspection, error) {
			close(started)
			<-attempt.Done()
			close(cancelled)
			awaitInspection(t, ctx, release, "shutdown inspection was never released")
			return Inspection{Pairing: "paired", Name: "Late result"}, nil
		}}
		m.inventory.Replace([]ios.DeviceEntry{inspectionDevice(1)})
		if err := m.reconcile(); err != nil {
			t.Fatal(err)
		}
		awaitInspection(t, ctx, started, "inspection never started")
		closed := make(chan error, 1)
		go func() { closed <- m.Close() }()
		awaitInspection(t, ctx, cancelled, "shutdown did not cancel inspection")
		synctest.Wait()
		select {
		case <-closed:
			t.Error("shutdown did not wait for inspection cleanup")
		default:
		}
		close(release)
		if err := awaitInspection(t, ctx, closed, "shutdown never finished"); err != nil {
			t.Fatal(err)
		}
		if m.roster().Candidates[0].Trusted {
			t.Fatal("shutdown applied a late inspection result")
		}
	})
}
