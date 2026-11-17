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
