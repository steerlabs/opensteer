package phone

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net"
	"testing"
	"time"

	"github.com/danielpaulus/go-ios/ios"
	"github.com/danielpaulus/go-ios/ios/tunnel"
	"github.com/danielpaulus/go-ios/ios/xpc"
)

type nopCloser struct{}

func (nopCloser) Close() error { return nil }
func rsdFixture(t *testing.T, identity string, port string) (ios.RsdService, *bytes.Buffer) {
	t.Helper()
	in, out := new(bytes.Buffer), new(bytes.Buffer)
	err := xpc.EncodeMessage(in, xpc.Message{Flags: xpc.AlwaysSetFlag | xpc.DataFlag, Id: 1, Body: map[string]interface{}{"MessageType": "Handshake", "MessagingProtocolVersion": uint64(7), "Properties": map[string]interface{}{"UniqueDeviceID": identity, "RemoteXPCVersionFlags": uint64(1)}, "Services": map[string]interface{}{DisplayService: map[string]interface{}{"Port": port}}}})
	if err != nil {
		t.Fatal(err)
	}
	c, err := xpc.New(out, in, nil, nopCloser{})
	if err != nil {
		t.Fatal(err)
	}
	// RSD receives on the client-server stream, whose write half records announcements.
	duplex := &fixtureDuplex{Reader: in, Writer: out}
	c, err = xpc.New(duplex, in, nil, nopCloser{})
	if err != nil {
		t.Fatal(err)
	}
	return ios.NewRsdServiceFromXPC(c, "synthetic-identity"), out
}

type fixtureDuplex struct {
	io.Reader
	io.Writer
}

func TestRSDAnnouncementAndRefresh(t *testing.T) {
	calls := 0
	announcements := []*bytes.Buffer{}
	s := &Session{identity: "synthetic-identity", newRSD: func(context.Context) (RSD, error) {
		calls++
		r, b := rsdFixture(t, "synthetic-identity", fmt.Sprint(10000+calls))
		announcements = append(announcements, b)
		return r, nil
	}}
	if err := s.Refresh(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := s.Refresh(context.Background()); err != nil {
		t.Fatal(err)
	}
	if s.services.GetPort(DisplayService) != 10002 {
		t.Fatal("ports not refreshed")
	}
	if announcements[0].Len() == 0 || announcements[1].Len() != 0 {
		t.Fatal("host announced more than once")
	}
	message, err := xpc.DecodeMessage(announcements[0])
	if err != nil || message.Body["MessageType"] != "Handshake" {
		t.Fatalf("host announcement: %v", err)
	}
	for _, identity := range []string{"other-identity", ""} {
		r, b := rsdFixture(t, identity, "10000")
		if _, err := r.HandshakeAsHost(); err == nil || b.Len() != 0 {
			t.Fatal("announced unverified identity")
		}
	}
	for _, port := range []string{"0", "65536", "invalid", "-1"} {
		r, _ := rsdFixture(t, "synthetic-identity", port)
		if _, err := r.Handshake(); err == nil {
			t.Fatalf("accepted port %s", port)
		}
	}
}
func TestCDTunnelHandshake(t *testing.T) {
	for _, bad := range []string{"", "magic", "mtu", "port", "address"} {
		t.Run(bad, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			client, peer := net.Pipe()
			defer peer.Close()
			served := make(chan error, 1)
			go func() {
				var header [10]byte
				if _, err := io.ReadFull(peer, header[:]); err != nil {
					served <- err
					return
				}
				rq := make([]byte, int(header[9]))
				if _, err := io.ReadFull(peer, rq); err != nil {
					served <- err
					return
				}
				if string(header[:9]) != "CDTunnel\x00" {
					served <- fmt.Errorf("wrong request magic")
					return
				}
				mtu, port, address := 1280, 62000, "fd00::2"
				if bad == "mtu" {
					mtu = 1
				}
				if bad == "port" {
					port = 0
				}
				if bad == "address" {
					address = "127.0.0.1"
				}
				body := []byte(fmt.Sprintf(`{"serverAddress":%q,"serverRSDPort":%d,"clientParameters":{"address":"fd00::1","mtu":%d}}`, address, port, mtu))
				packet := append([]byte("CDTunnel\x00"), byte(len(body)))
				packet = append(packet, body...)
				if bad == "magic" {
					packet[0] = 'X'
					packet = packet[:10]
				}
				_, err := peer.Write(packet)
				served <- err
			}()
			tunnel, err := tunnel.OpenUserspace(ctx, oneByteConn{client})
			if bad != "" {
				if err == nil {
					tunnel.Close()
					t.Fatal("accepted invalid handshake")
				}
			} else {
				if err != nil {
					t.Fatal(err)
				}
				if tunnel.RSDPort != 62000 || !tunnel.RemoteIP.Equal(net.ParseIP("fd00::2")) {
					t.Fatal("wrong RSD endpoint")
				}
				tunnel.Close()
				tunnel.Wait()
			}
			select {
			case err := <-served:
				if err != nil {
					t.Fatal(err)
				}
			case <-ctx.Done():
				t.Fatal("handshake did not settle")
			}
		})
	}
}

type oneByteConn struct{ net.Conn }

func (c oneByteConn) Read(b []byte) (int, error) { return c.Conn.Read(b[:min(1, len(b))]) }
func TestTunnelBlockedReadCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	a, b := net.Pipe()
	defer b.Close()
	tunnel, err := tunnel.OpenPacketStream(ctx, a, "fd00::1", "fd00::2", 1280)
	if err != nil {
		t.Fatal(err)
	}
	cancel()
	done := make(chan struct{})
	go func() { tunnel.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("blocked packet read survived close")
	}
}

func TestConnectionContextTransfersToSession(t *testing.T) {
	setup, cancelSetup := context.WithCancel(context.Background())
	lifetime, cancelLifetime := context.WithCancel(context.Background())
	defer cancelLifetime()
	client, peer := net.Pipe()
	defer peer.Close()
	connection := ios.NewDeviceConnectionWithConn(client)
	defer connection.Close()
	connection.BindContext(setup)
	connection.BindContext(lifetime)
	cancelSetup()
	_ = connection.Conn().SetDeadline(time.Now().Add(time.Second))
	_ = peer.SetDeadline(time.Now().Add(time.Second))
	done := make(chan error, 1)
	go func() { _, err := peer.Write([]byte("session")); done <- err }()
	var b [7]byte
	if _, err := io.ReadFull(connection, b[:]); err != nil {
		t.Fatal("setup cancellation closed transferred connection", err)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	cancelLifetime()
	if _, err := connection.Read(b[:]); err == nil {
		t.Fatal("session cancellation did not close connection")
	}
}
