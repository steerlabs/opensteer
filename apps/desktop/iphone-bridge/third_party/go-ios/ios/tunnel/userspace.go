package tunnel

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"sync"

	"gvisor.dev/gvisor/pkg/buffer"
	"gvisor.dev/gvisor/pkg/tcpip"
	"gvisor.dev/gvisor/pkg/tcpip/adapters/gonet"
	"gvisor.dev/gvisor/pkg/tcpip/header"
	"gvisor.dev/gvisor/pkg/tcpip/link/channel"
	"gvisor.dev/gvisor/pkg/tcpip/network/ipv6"
	"gvisor.dev/gvisor/pkg/tcpip/stack"
	"gvisor.dev/gvisor/pkg/tcpip/transport/tcp"
	"gvisor.dev/gvisor/pkg/tcpip/transport/udp"
)

var ErrTunnel = errors.New("invalid tunnel protocol")

type Parameters struct {
	ServerAddress    string
	ServerRSDPort    uint64
	ClientParameters struct {
		Address string
		Netmask string
		Mtu     uint64
	}
}

func exchangeCoreTunnelParameters(stream io.ReadWriteCloser) (Parameters, error) {
	rq := []byte(`{"type":"clientHandshakeRequest","mtu":1280}`)
	packet := append([]byte("CDTunnel\x00"), byte(len(rq)))
	packet = append(packet, rq...)
	if err := writePacket(stream, packet); err != nil {
		return Parameters{}, err
	}
	var header [10]byte
	if _, err := io.ReadFull(stream, header[:]); err != nil {
		return Parameters{}, err
	}
	if !bytes.Equal(header[:9], []byte("CDTunnel\x00")) || header[9] == 0 {
		return Parameters{}, ErrTunnel
	}
	b := make([]byte, int(header[9]))
	if _, err := io.ReadFull(stream, b); err != nil {
		return Parameters{}, err
	}
	var p Parameters
	if json.Unmarshal(b, &p) != nil || p.ServerRSDPort < 1 || p.ServerRSDPort > 65535 || p.ClientParameters.Mtu < 1280 || p.ClientParameters.Mtu > 65535 {
		return p, ErrTunnel
	}
	local, remote := net.ParseIP(p.ClientParameters.Address), net.ParseIP(p.ServerAddress)
	if local == nil || remote == nil || local.To4() != nil || remote.To4() != nil || local.Equal(remote) || local.IsUnspecified() || remote.IsUnspecified() || local.IsMulticast() || remote.IsMulticast() {
		return p, ErrTunnel
	}
	return p, nil
}

// Userspace owns a private IPv6 stack; no host route, device, socket listener or forwarding API exists.
type Userspace struct {
	LocalIP  net.IP
	RemoteIP net.IP
	RSDPort  uint16
	Stack    *stack.Stack
	link     *channel.Endpoint
	conn     io.ReadWriteCloser
	ctx      context.Context
	cancel   context.CancelFunc
	once     sync.Once
	wg       sync.WaitGroup
}

func OpenUserspace(ctx context.Context, conn io.ReadWriteCloser) (*Userspace, error) {
	stop := context.AfterFunc(ctx, func() { _ = conn.Close() })
	p, err := exchangeCoreTunnelParameters(conn)
	stop()
	if err != nil || ctx.Err() != nil {
		_ = conn.Close()
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, err
	}
	t, err := OpenPacketStream(ctx, conn, p.ClientParameters.Address, p.ServerAddress, uint32(p.ClientParameters.Mtu))
	if err == nil {
		t.RSDPort = uint16(p.ServerRSDPort)
	}
	return t, err
}
func OpenPacketStream(parent context.Context, conn io.ReadWriteCloser, local, remote string, mtu uint32) (*Userspace, error) {
	l, r := net.ParseIP(local), net.ParseIP(remote)
	if l == nil || r == nil || l.To4() != nil || r.To4() != nil || l.Equal(r) || mtu < 1280 || mtu > 65535 {
		_ = conn.Close()
		return nil, ErrTunnel
	}
	ctx, cancel := context.WithCancel(parent)
	s := stack.New(stack.Options{NetworkProtocols: []stack.NetworkProtocolFactory{ipv6.NewProtocol}, TransportProtocols: []stack.TransportProtocolFactory{tcp.NewProtocol, udp.NewProtocol}})
	link := channel.New(64, mtu, "")
	t := &Userspace{LocalIP: l, RemoteIP: r, Stack: s, link: link, conn: conn, ctx: ctx, cancel: cancel}
	if err := s.CreateNIC(1, link); err != nil {
		t.Close()
		return nil, ErrTunnel
	}
	address := tcpip.AddrFromSlice(l.To16()).WithPrefix()
	address.PrefixLen = 64
	if err := s.AddProtocolAddress(1, tcpip.ProtocolAddress{Protocol: ipv6.ProtocolNumber, AddressWithPrefix: address}, stack.AddressProperties{}); err != nil {
		t.Close()
		return nil, ErrTunnel
	}
	subnet, _ := tcpip.NewSubnet(tcpip.AddrFromSlice(r.To16()), tcpip.MaskFromBytes(bytes.Repeat([]byte{255}, 16)))
	s.SetRouteTable([]tcpip.Route{{Destination: subnet, NIC: 1}})
	t.wg.Add(2)
	go func() {
		defer t.wg.Done()
		defer func() {
			if recover() != nil {
				_ = t.Close()
			}
		}()
		defer t.Close()
		reader := newFramedIPv6Reader(conn)
		packet := make([]byte, mtu)
		for {
			n, err := reader.Read(packet)
			if err != nil {
				return
			}
			// Only the negotiated peer can deliver packets to this stack.
			if !net.IP(packet[8:24]).Equal(r) || !net.IP(packet[24:40]).Equal(l) {
				continue
			}
			p := stack.NewPacketBuffer(stack.PacketBufferOptions{Payload: buffer.MakeWithData(append([]byte{}, packet[:n]...))})
			link.InjectInbound(header.IPv6ProtocolNumber, p)
			p.DecRef()
		}
	}()
	go func() {
		defer t.wg.Done()
		defer func() {
			if recover() != nil {
				_ = t.Close()
			}
		}()
		defer t.Close()
		for {
			p := link.ReadContext(ctx)
			if p == nil {
				return
			}
			b := p.ToBuffer()
			data := b.Flatten()
			err := writePacket(conn, data)
			b.Release()
			p.DecRef()
			if err != nil {
				return
			}
		}
	}()
	context.AfterFunc(ctx, func() { _ = t.Close() })
	return t, nil
}
func (t *Userspace) Close() error {
	t.once.Do(func() { t.cancel(); _ = t.conn.Close(); t.Stack.Close(); t.link.Close() })
	return nil
}
func (t *Userspace) Wait()                 { t.wg.Wait(); t.Stack.Wait() }
func (t *Userspace) Done() <-chan struct{} { return t.ctx.Done() }
func (t *Userspace) DialTCP(ctx context.Context, port uint16) (net.Conn, error) {
	if port == 0 {
		return nil, ErrTunnel
	}
	c, err := gonet.DialContextTCP(ctx, t.Stack, tcpip.FullAddress{NIC: 1, Addr: tcpip.AddrFromSlice(t.RemoteIP.To16()), Port: port}, ipv6.ProtocolNumber)
	if err != nil {
		return nil, err
	}
	return bindContext(ctx, c), nil
}
func (t *Userspace) ListenUDP(ctx context.Context) (net.PacketConn, error) {
	c, err := gonet.DialUDP(t.Stack, &tcpip.FullAddress{NIC: 1, Addr: tcpip.AddrFromSlice(t.LocalIP.To16())}, nil, ipv6.ProtocolNumber)
	if err != nil {
		return nil, err
	}
	context.AfterFunc(ctx, func() { _ = c.Close() })
	return c, nil
}
func bindContext(ctx context.Context, c net.Conn) net.Conn {
	stop := context.AfterFunc(ctx, func() { _ = c.Close() })
	if d, ok := ctx.Deadline(); ok {
		_ = c.SetDeadline(d)
	}
	return &contextConn{Conn: c, stop: stop}
}

type contextConn struct {
	net.Conn
	stop func() bool
}

func (c *contextConn) Close() error { c.stop(); return c.Conn.Close() }
func writePacket(w io.Writer, b []byte) error {
	for len(b) > 0 {
		n, err := w.Write(b)
		if err != nil {
			return err
		}
		if n == 0 {
			return io.ErrShortWrite
		}
		b = b[n:]
	}
	return nil
}
