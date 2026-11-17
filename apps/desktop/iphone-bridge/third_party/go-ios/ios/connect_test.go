package ios

import (
	"context"
	"fmt"
	"net"
	"sync"
	"testing"
	"time"
)

type closeSignalConn struct {
	net.Conn
	once   sync.Once
	closed chan struct{}
}

func (c *closeSignalConn) Close() error {
	c.once.Do(func() { close(c.closed) })
	return c.Conn.Close()
}

func TestShimCheckinFailureAndCancellationCloseConnection(t *testing.T) {
	for _, abort := range []bool{false, true} {
		t.Run(fmt.Sprint(abort), func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			client, peer := net.Pipe()
			defer client.Close()
			defer peer.Close()
			_ = peer.SetDeadline(time.Now().Add(time.Second))
			tracked := &closeSignalConn{Conn: client, closed: make(chan struct{})}
			served := make(chan error, 1)
			go func() {
				codec := NewPlistCodecReadWriter(peer, peer)
				var request map[string]interface{}
				if err := codec.Read(&request); err != nil {
					served <- err
					return
				}
				if request["Request"] != "RSDCheckin" {
					served <- fmt.Errorf("missing shim check-in")
					return
				}
				if abort {
					cancel()
				} else {
					_ = peer.Close()
				}
				served <- nil
			}()
			const service = "com.apple.mobile.lockdown.remote.trusted"
			d := DeviceEntry{Address: "fd00::2", Context: ctx, Rsd: RsdHandshakeResponse{Services: map[string]RsdServiceEntry{service: {Port: 10001}}}, DialService: func(context.Context, uint16) (net.Conn, error) { return tracked, nil }}
			result := make(chan error, 1)
			go func() {
				conn, err := ConnectToShimService(d, service)
				if conn != nil {
					_ = conn.Close()
				}
				result <- err
			}()
			select {
			case err := <-result:
				if err == nil {
					t.Fatal("accepted incomplete shim check-in")
				}
			case <-time.After(time.Second):
				_ = client.Close()
				t.Fatal("shim check-in did not finish after cancellation/EOF")
			}
			select {
			case <-tracked.closed:
			default:
				t.Fatal("failed shim connection leaked")
			}
			select {
			case err := <-served:
				if err != nil {
					t.Fatal(err)
				}
			case <-time.After(time.Second):
				t.Fatal("shim fixture did not finish")
			}
		})
	}
}
