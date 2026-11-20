package phone

import (
	"context"
	"errors"
	"log/slog"
	"net"
	"sync"
	"time"

	"github.com/danielpaulus/go-ios/ios"
	"github.com/danielpaulus/go-ios/ios/http"
	"github.com/danielpaulus/go-ios/ios/tunnel"
	"github.com/danielpaulus/go-ios/ios/xpc"
	"github.com/steerlabs/opensteer/iphone-bridge/internal/wire"
)

const (
	DisplayService = "com.apple.coredevice.displayservice"
	CryptexService = "com.apple.security.cryptexd.remote"
)

type ServiceDialer interface {
	DialService(context.Context, string) (net.Conn, error)
	OpenXPC(context.Context, string) (*xpc.Connection, error)
	Close() error
}
type RSD interface {
	Handshake() (ios.RsdHandshakeResponse, error)
	HandshakeAsHost() (ios.RsdHandshakeResponse, error)
	Close() error
}
type Session struct {
	mu           sync.Mutex
	closeOnce    sync.Once
	closeErr     error
	tunnel       *tunnel.Userspace
	dialTCP      func(context.Context, uint16) (net.Conn, error)
	identity     string
	services     ios.RsdHandshakeResponse
	announced    bool
	newRSD       func(context.Context) (RSD, error)
	openLockdown func(context.Context) (*ios.LockDownConnection, error)
	screen       *screenSession
	closed       bool
	state        DeviceState
	stateReason  wire.Reason
	ddiReason    wire.Reason
}

func OpenSession(lifetime, setup context.Context, device ios.DeviceEntry) (*Session, error) {
	device.Context = setup
	conn, err := ios.ConnectToService(device, "com.apple.internal.devicecompute.CoreDeviceProxy")
	if err != nil {
		return nil, Classify(err, wire.TunnelFailed)
	}
	if owned, ok := conn.(*ios.DeviceConnection); ok {
		owned.BindContext(lifetime)
	} else {
		_ = conn.Close()
		return nil, wire.Fail(wire.ProtocolUnsupported)
	}
	// The setup deadline bounds negotiation; the session context owns the completed transport.
	gate := context.AfterFunc(setup, func() { _ = conn.Close() })
	t, err := tunnel.OpenUserspace(lifetime, conn)
	gate()
	if err != nil {
		return nil, Classify(err, wire.TunnelFailed)
	}
	s, err := sessionFromTunnel(setup, t, device.Properties.SerialNumber)
	if err != nil {
		return nil, err
	}
	if device.Properties.ConnectionType == "USB" {
		s.openLockdown = func(ctx context.Context) (*ios.LockDownConnection, error) {
			d := device
			d.Context = ctx
			return ios.ConnectLockdownWithSession(d)
		}
	}
	return s, nil
}

func sessionFromTunnel(setup context.Context, t *tunnel.Userspace, identity string) (*Session, error) {
	s := &Session{tunnel: t, identity: identity, dialTCP: t.DialTCP}
	s.openLockdown = func(ctx context.Context) (*ios.LockDownConnection, error) {
		return remoteLockdown(s.Device(ctx, ios.DeviceEntry{}))
	}
	s.newRSD = func(ctx context.Context) (RSD, error) {
		c, err := t.DialTCP(ctx, t.RSDPort)
		if err != nil {
			return nil, err
		}
		r, err := ios.NewRsdServiceFromConn(c, s.identity)
		if err != nil {
			_ = c.Close()
			return nil, err
		}
		return r, nil
	}
	if err := s.Refresh(setup); err != nil {
		s.Close()
		return nil, err
	}
	return s, nil
}
func (s *Session) Refresh(ctx context.Context) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return wire.Fail(wire.NoSession)
	}
	r, err := s.newRSD(ctx)
	if err != nil {
		return Classify(err, wire.TunnelFailed)
	}
	defer r.Close()
	var reply ios.RsdHandshakeResponse
	if s.announced {
		reply, err = r.Handshake()
	} else {
		reply, err = r.HandshakeAsHost()
	}
	if err != nil {
		return Classify(err, wire.ProtocolUnsupported)
	}
	if reply.Udid != s.identity {
		return wire.Fail(wire.IdentityMismatch)
	}
	s.announced = true
	s.services = reply
	return nil
}
func (s *Session) DialService(ctx context.Context, name string) (conn net.Conn, err error) {
	start := time.Now()
	defer func() {
		reason := ""
		if err != nil {
			reason = string(Classify(err, wire.NativeServiceFailed).Code)
		}
		slog.Debug("bridge.service", "service", name, "durationMs", time.Since(start).Milliseconds(), "reason", reason)
	}()
	s.mu.Lock()
	closed := s.closed
	port := s.services.GetPort(name)
	dial := s.dialTCP
	s.mu.Unlock()
	if closed || dial == nil {
		return nil, wire.Fail(wire.NoSession)
	}
	if port < 1 || port > 65535 {
		return nil, wire.Fail(wire.ServiceMissing)
	}
	return dial(ctx, uint16(port))
}
func (s *Session) OpenXPC(ctx context.Context, name string) (*xpc.Connection, error) {
	c, err := s.DialService(ctx, name)
	if err != nil {
		return nil, err
	}
	h, err := http.NewHttpConnection(c)
	if err != nil {
		_ = c.Close()
		return nil, Classify(err, wire.ProtocolUnsupported)
	}
	x, err := ios.CreateXpcConnection(h)
	if err != nil {
		_ = h.Close()
		return nil, Classify(err, wire.ProtocolUnsupported)
	}
	return x, nil
}
func (s *Session) Device(ctx context.Context, d ios.DeviceEntry) ios.DeviceEntry {
	s.mu.Lock()
	defer s.mu.Unlock()
	d.Context = ctx
	d.Address = s.tunnel.RemoteIP.String()
	d.Rsd = s.services
	d.DialService = func(ctx context.Context, p uint16) (net.Conn, error) { return s.tunnel.DialTCP(ctx, p) }
	return d
}
func (s *Session) Close() error {
	s.closeOnce.Do(func() {
		s.mu.Lock()
		s.closed = true
		screen := s.screen
		t := s.tunnel
		s.mu.Unlock()
		if screen != nil {
			screen.close()
		}
		if t != nil {
			_ = t.Close()
			t.Wait()
		}
	})
	return s.closeErr
}
func (s *Session) Done() <-chan struct{} {
	if s.tunnel == nil {
		return nil
	}
	return s.tunnel.Done()
}
func Classify(err error, fallback wire.Reason) (result *wire.Failure) {
	if err != nil {
		defer func() {
			slog.Debug("bridge.native-error", "err", err, "reason", string(result.Code))
		}()
	}
	if errors.Is(err, ios.ErrRSDIdentityMismatch) {
		return wire.Fail(wire.IdentityMismatch)
	}
	var f *wire.Failure
	if errors.As(err, &f) {
		return f
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return wire.Fail(wire.DeadlineExceeded)
	}
	if errors.Is(err, context.Canceled) {
		return wire.Fail(wire.Cancelled)
	}
	var lockdown *ios.LockdownError
	if errors.As(err, &lockdown) {
		switch lockdown.Code {
		case "PairingDialogResponsePending":
			return wire.Fail(wire.TrustPending)
		case "UserDeniedPairing":
			return wire.Fail(wire.TrustDenied)
		case "PasswordProtected", "DeviceLocked":
			return wire.Fail(wire.PhoneLocked)
		case "InvalidHostID", "InvalidPairRecord":
			return wire.Fail(wire.PairingRevoked)
		}
	}
	var pair *ios.PairRecordError
	if errors.As(err, &pair) {
		return wire.Fail(wire.TrustRequired)
	}
	return wire.Fail(fallback)
}
