package phone

import (
	"context"
	"encoding/binary"
	"io"
	"net"
	"testing"
	"time"

	"github.com/danielpaulus/go-ios/ios/tunnel"
	"gvisor.dev/gvisor/pkg/tcpip"
	"gvisor.dev/gvisor/pkg/tcpip/adapters/gonet"
	"gvisor.dev/gvisor/pkg/tcpip/network/ipv6"
)

func TestNetstackTCPAndUDP(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	a, b := net.Pipe()
	left, err := tunnel.OpenPacketStream(ctx, a, "fd00::1", "fd00::2", 1280)
	if err != nil {
		t.Fatal(err)
	}
	right, err := tunnel.OpenPacketStream(ctx, b, "fd00::2", "fd00::1", 1280)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { left.Close(); right.Close(); left.Wait(); right.Wait() }()
	listener, err := gonet.ListenTCP(right.Stack, tcpip.FullAddress{NIC: 1, Addr: tcpip.AddrFromSlice(net.ParseIP("fd00::2").To16()), Port: 10001}, ipv6.ProtocolNumber)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	done := make(chan error, 1)
	go func() {
		c, e := listener.Accept()
		if e != nil {
			done <- e
			return
		}
		defer c.Close()
		_ = c.SetDeadline(time.Now().Add(time.Second))
		var buf [4]byte
		_, e = io.ReadFull(c, buf[:])
		if e == nil {
			_, e = c.Write(buf[:])
		}
		done <- e
	}()
	c, err := left.DialTCP(ctx, 10001)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if _, err := c.Write([]byte("test")); err != nil {
		t.Fatal(err)
	}
	var buf [4]byte
	if _, err := io.ReadFull(c, buf[:]); err != nil || string(buf[:]) != "test" {
		t.Fatalf("TCP: %q %v", buf, err)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	u, err := left.ListenUDP(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer u.Close()
	v, err := right.ListenUDP(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer v.Close()
	_ = u.SetDeadline(time.Now().Add(time.Second))
	_ = v.SetDeadline(time.Now().Add(time.Second))
	if _, err := u.WriteTo([]byte("private"), &net.UDPAddr{IP: net.ParseIP("fd00::99"), Port: 9999}); err == nil {
		t.Fatal("UDP escaped the negotiated peer")
	}
	if _, err := u.WriteTo([]byte("udp"), v.LocalAddr()); err != nil {
		t.Fatal(err)
	}
	data := make([]byte, 64)
	n, addr, err := v.ReadFrom(data)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := v.WriteTo(data[:n], addr); err != nil {
		t.Fatal(err)
	}
	n, _, err = u.ReadFrom(data)
	if err != nil || string(data[:n]) != "udp" {
		t.Fatalf("UDP: %q %v", data[:n], err)
	}
	cancel()
	if _, _, err = u.ReadFrom(data); err == nil {
		t.Fatal("UDP survived cancellation")
	} else if failure, ok := err.(net.Error); ok && failure.Timeout() {
		t.Fatal("UDP waited for deadline instead of cancellation")
	}
}

func TestInvalidPacketClosesTunnel(t *testing.T) {
	for _, oversized := range []bool{false, true} {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		client, peer := net.Pipe()
		tunnel, err := tunnel.OpenPacketStream(ctx, client, "fd00::1", "fd00::2", 1280)
		if err != nil {
			t.Fatal(err)
		}
		packet := make([]byte, 40)
		packet[0] = 0x40
		if oversized {
			packet[0] = 0x60
			binary.BigEndian.PutUint16(packet[4:6], 1241)
		}
		if _, err := peer.Write(packet); err != nil {
			t.Fatal(err)
		}
		select {
		case <-tunnel.Done():
		case <-ctx.Done():
			t.Fatal("corrupt packet did not close tunnel")
		}
		tunnel.Wait()
		peer.Close()
		cancel()
	}
}

type failingPacketWriter struct{ io.ReadCloser }

func (failingPacketWriter) Write([]byte) (int, error) { return 0, io.ErrClosedPipe }
func TestWriteFailureClosesBlockedRead(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	reader, writer := io.Pipe()
	defer writer.Close()
	tunnel, err := tunnel.OpenPacketStream(ctx, failingPacketWriter{reader}, "fd00::1", "fd00::2", 1280)
	if err != nil {
		t.Fatal(err)
	}
	udp, err := tunnel.ListenUDP(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer udp.Close()
	_, _ = udp.WriteTo([]byte("synthetic"), &net.UDPAddr{IP: net.ParseIP("fd00::2"), Port: 1234})
	select {
	case <-tunnel.Done():
	case <-ctx.Done():
		t.Fatal("write failure left tunnel active")
	}
	tunnel.Wait()
}
