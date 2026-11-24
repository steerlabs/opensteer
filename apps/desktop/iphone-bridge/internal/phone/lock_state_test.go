package phone

import (
	"context"
	"fmt"
	"io"
	"net"
	"testing"
	"time"

	"github.com/danielpaulus/go-ios/ios"
)

func TestLockStateUsesTrustedRemoteLockdown(t *testing.T) {
	for _, test := range []struct {
		name  string
		reply map[string]interface{}
		want  string
	}{
		{"locked", map[string]interface{}{"Value": true}, "locked"},
		{"unlocked", map[string]interface{}{"Value": false}, "unlocked"},
		{"missing", map[string]interface{}{}, "unknown"},
		{"wrong type", map[string]interface{}{"Value": "false"}, "unknown"},
		{"rejected", map[string]interface{}{"Value": false, "Error": "InvalidHostID"}, "unknown"},
	} {
		t.Run(test.name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			client, peer := net.Pipe()
			defer client.Close()
			defer peer.Close()
			_ = peer.SetDeadline(time.Now().Add(time.Second))
			done := make(chan error, 1)
			go func() {
				codec := ios.NewPlistCodecReadWriter(peer, peer)
				var request map[string]interface{}
				if err := codec.Read(&request); err != nil {
					done <- err
					return
				}
				if request["Request"] != "RSDCheckin" {
					done <- fmt.Errorf("missing RSD check-in")
					return
				}
				for range 2 {
					if err := codec.Write(map[string]interface{}{}); err != nil {
						done <- err
						return
					}
				}
				if err := codec.Read(&request); err != nil {
					done <- err
					return
				}
				if request["Request"] != "GetValue" || request["Key"] != "PasswordProtected" {
					done <- fmt.Errorf("lock state did not query lockdown PasswordProtected")
					return
				}
				if err := codec.Write(test.reply); err != nil {
					done <- err
					return
				}
				var b [1]byte
				_, err := peer.Read(b[:])
				if err != io.EOF {
					done <- fmt.Errorf("lockdown connection not closed: %v", err)
					return
				}
				done <- nil
			}()
			calls := 0
			d := ios.DeviceEntry{Address: "fd00::2", Context: ctx, Rsd: ios.RsdHandshakeResponse{Services: map[string]ios.RsdServiceEntry{remoteLockdownService: {Port: 10001}}}}
			d.DialService = func(_ context.Context, port uint16) (net.Conn, error) {
				calls++
				if port != 10001 {
					return nil, fmt.Errorf("lockdown bypassed RSD service map")
				}
				return client, nil
			}
			s := &Session{openLockdown: func(context.Context) (*ios.LockDownConnection, error) { return remoteLockdown(d) }}
			if state := s.readLockState(ctx); state != test.want {
				t.Fatalf("lock=%s want=%s", state, test.want)
			}
			if calls != 1 {
				t.Fatalf("state opened %d lockdown connections", calls)
			}
			select {
			case err := <-done:
				if err != nil {
					t.Fatal(err)
				}
			case <-ctx.Done():
				t.Fatal("lockdown request and cleanup did not finish")
			}
		})
	}
}

func TestLockStateUnreadableOrClosedIsUnknown(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	for _, test := range []struct {
		name   string
		ctx    context.Context
		closed bool
	}{
		{"unreadable", context.Background(), false},
		{"closed", context.Background(), true},
		{"cancelled", ctx, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			calls := 0
			s := &Session{closed: test.closed, openLockdown: func(context.Context) (*ios.LockDownConnection, error) { calls++; return nil, io.ErrClosedPipe }}
			if state := s.readLockState(test.ctx); state != "unknown" {
				t.Fatalf("lock=%s", state)
			}
			if (test.closed || test.ctx.Err() != nil) && calls != 0 {
				t.Fatal("opened lockdown outside live session")
			}
		})
	}
}

func TestLockStateCancellationClosesBlockedGetValue(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	client, peer := net.Pipe()
	defer peer.Close()
	_ = peer.SetDeadline(time.Now().Add(time.Second))
	done := make(chan error, 1)
	go func() {
		codec := ios.NewPlistCodecReadWriter(peer, peer)
		var request map[string]interface{}
		if err := codec.Read(&request); err != nil {
			done <- err
			return
		}
		cancel()
		var b [1]byte
		_, err := peer.Read(b[:])
		if err != io.EOF {
			done <- fmt.Errorf("cancelled lockdown connection not closed: %v", err)
			return
		}
		done <- nil
	}()
	s := &Session{openLockdown: func(context.Context) (*ios.LockDownConnection, error) {
		return ios.NewLockDownConnection(ios.NewDeviceConnectionWithConn(client)), nil
	}}
	result := make(chan string, 1)
	go func() { result <- s.readLockState(ctx) }()
	select {
	case state := <-result:
		if state != "unknown" {
			t.Fatal("cancelled lock state became readable")
		}
	case <-time.After(time.Second):
		_ = client.Close()
		t.Fatal("GetValue did not return after cancellation")
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("cancelled lockdown fixture did not finish")
	}
}

func TestWarmLockdownReusesConnectionAndReconnectsOnEOF(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	life, lifeCancel := context.WithCancel(context.Background())
	defer lifeCancel()

	opens := 0
	var peers []net.Conn
	servePeer := func(replies ...map[string]interface{}) net.Conn {
		client, peer := net.Pipe()
		peers = append(peers, peer)
		go func() {
			defer peer.Close()
			codec := ios.NewPlistCodecReadWriter(peer, peer)
			for _, reply := range replies {
				var req map[string]interface{}
				if err := codec.Read(&req); err != nil {
					return
				}
				if req["Request"] != "GetValue" || req["Key"] != "PasswordProtected" {
					return
				}
				if err := codec.Write(reply); err != nil {
					return
				}
			}
		}()
		return client
	}

	w := &warmLockdown{
		life: life,
		open: func(context.Context) (*ios.LockDownConnection, error) {
			opens++
			if opens == 1 {
				// First connection serves two GetValue queries, then closes (simulating idle EOF).
				return ios.NewLockDownConnection(ios.NewDeviceConnectionWithConn(
					servePeer(
						map[string]interface{}{"Value": false},
						map[string]interface{}{"Value": true},
					),
				)), nil
			}
			// Second connection serves the transparent reconnect retry.
			return ios.NewLockDownConnection(ios.NewDeviceConnectionWithConn(
				servePeer(map[string]interface{}{"Value": false}),
			)), nil
		},
	}
	defer w.close()

	if got := w.read(ctx); got != "unlocked" {
		t.Fatalf("first read=%s want=unlocked", got)
	}
	if got := w.read(ctx); got != "locked" {
		t.Fatalf("second read=%s want=locked", got)
	}
	if opens != 1 {
		t.Fatalf("expected 1 warm lockdown open across 2 reads, got %d", opens)
	}
	// Peer 1 exits after serving 2 replies, causing EOF on the 3rd read; warmLockdown must reconnect once transparently.
	if got := w.read(ctx); got != "unlocked" {
		t.Fatalf("third read after EOF=%s want=unlocked", got)
	}
	if opens != 2 {
		t.Fatalf("expected transparent reconnect (2 opens), got %d", opens)
	}
}

func TestWarmLockdownBoundsStalledCallAndRespectsMonitorDeadline(t *testing.T) {
	life, lifeCancel := context.WithCancel(context.Background())
	defer lifeCancel()

	opens := 0
	stalledReq := make(chan struct{}, 1)
	var firstPeer net.Conn
	w := &warmLockdown{
		life: life,
		open: func(context.Context) (*ios.LockDownConnection, error) {
			opens++
			client, peer := net.Pipe()
			if opens == 1 {
				firstPeer = peer
				go func() {
					defer peer.Close()
					codec := ios.NewPlistCodecReadWriter(peer, peer)
					var req map[string]interface{}
					if err := codec.Read(&req); err == nil {
						stalledReq <- struct{}{}
						// Stall without replying until closed.
						var b [1]byte
						_, _ = peer.Read(b[:])
					}
				}()
				return ios.NewLockDownConnection(ios.NewDeviceConnectionWithConn(client)), nil
			}
			go func() {
				defer peer.Close()
				codec := ios.NewPlistCodecReadWriter(peer, peer)
				var req map[string]interface{}
				if err := codec.Read(&req); err == nil {
					_ = codec.Write(map[string]interface{}{"Value": false})
				}
			}()
			return ios.NewLockDownConnection(ios.NewDeviceConnectionWithConn(client)), nil
		},
	}
	defer w.close()

	// Start a slow caller that stalls inside GetValue.
	slowCtx, slowCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer slowCancel()
	slowResult := make(chan string, 1)
	go func() { slowResult <- w.read(slowCtx) }()
	select {
	case <-stalledReq:
	case <-time.After(time.Second):
		t.Fatal("stalled caller never reached peer")
	}

	// A concurrent monitor call with a short deadline must return "unknown" promptly without
	// waiting for the stalled caller.
	monStart := time.Now()
	monCtx, monCancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer monCancel()
	if got := w.read(monCtx); got != "unknown" {
		t.Fatalf("monitor read=%s want=unknown", got)
	}
	if elapsed := time.Since(monStart); elapsed > 250*time.Millisecond {
		t.Fatalf("monitor read blocked for %v past its 50ms deadline", elapsed)
	}

	// Cancel the stalled caller and verify the next read reconnects cleanly.
	slowCancel()
	if firstPeer != nil {
		_ = firstPeer.Close()
	}
	select {
	case got := <-slowResult:
		if got != "unknown" {
			t.Fatalf("cancelled slow read=%s want=unknown", got)
		}
	case <-time.After(time.Second):
		t.Fatal("cancelled slow read did not exit")
	}

	recoverCtx, recoverCancel := context.WithTimeout(context.Background(), time.Second)
	defer recoverCancel()
	if got := w.read(recoverCtx); got != "unlocked" {
		t.Fatalf("recovery read=%s want=unlocked", got)
	}
	if opens != 2 {
		t.Fatalf("expected reconnect on recovery read, got %d opens", opens)
	}
}
