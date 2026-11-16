package phone

import (
	"context"
	"errors"
	"net"
	"sync"
	"sync/atomic"
	"time"

	"github.com/danielpaulus/go-ios/ios"
	"github.com/danielpaulus/go-ios/ios/display"
	"github.com/danielpaulus/go-ios/ios/http"
	"github.com/google/uuid"
	"github.com/steerlabs/opensteer/iphone-bridge/internal/wire"
)

type MediaControl interface {
	StartVideoStream(context.Context, display.VideoStreamRequest) (uuid.UUID, error)
	StopMediaStream(context.Context, uuid.UUID) error
	Close() error
}
type MediaSession struct {
	receiver net.PacketConn
	open     func(context.Context) (MediaControl, error)
	id       uuid.UUID
	once     sync.Once
	ready    atomic.Bool
	done     chan struct{}
	err      error
}

func StartMedia(ctx context.Context, receiver net.PacketConn, remote net.IP, open func(context.Context) (MediaControl, error)) (*MediaSession, error) {
	m := &MediaSession{receiver: receiver, open: open, done: make(chan struct{})}
	control, err := open(ctx)
	if err != nil {
		_ = receiver.Close()
		return nil, Classify(err, wire.MediaRequired)
	}
	address, ok := receiver.LocalAddr().(*net.UDPAddr)
	if !ok {
		_ = control.Close()
		_ = receiver.Close()
		return nil, wire.Fail(wire.ProtocolUnsupported)
	}
	m.id, err = control.StartVideoStream(ctx, display.VideoStreamRequest{ReceiverIP: address.IP.String(), ReceiverPort: address.Port, SenderIP: remote.String(), DisplayID: 1})
	_ = control.Close()
	if err != nil {
		_ = m.Close()
		return nil, Classify(err, wire.MediaRequired)
	}
	ready := make(chan struct{})
	readErr := make(chan error, 1)
	go func() {
		defer close(m.done)
		defer func() {
			if recover() != nil {
				_ = receiver.Close()
			}
		}()
		defer m.ready.Store(false)
		data := make([]byte, 65535)
		first := true
		for {
			n, source, err := receiver.ReadFrom(data)
			if err != nil {
				readErr <- err
				return
			}
			peer, ok := source.(*net.UDPAddr)
			if !ok || !peer.IP.Equal(remote) || n <= 12+4*int(data[0]&15) || data[0]>>6 != 2 {
				continue
			}
			if first {
				first = false
				m.ready.Store(true)
				close(ready)
			}
		}
	}()
	select {
	case <-ready:
		return m, nil
	case <-ctx.Done():
		_ = m.Close()
		return nil, Classify(ctx.Err(), wire.MediaRequired)
	case <-readErr:
		_ = m.Close()
		return nil, wire.Fail(wire.MediaRequired)
	}
}
func (m *MediaSession) Ready() bool           { return m.ready.Load() }
func (m *MediaSession) Done() <-chan struct{} { return m.done }
func (m *MediaSession) Close() error {
	m.once.Do(func() {
		m.ready.Store(false)
		_ = m.receiver.Close()
		if m.id != uuid.Nil {
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			service, err := m.open(ctx)
			if err != nil {
				m.err = wire.Fail(wire.MediaRequired)
				return
			}
			defer service.Close()
			if err := service.StopMediaStream(ctx, m.id); err != nil {
				m.err = Classify(err, wire.MediaRequired)
			}
		}
	})
	return m.err
}
func (s *Session) StartMedia(lifetime, request context.Context) error {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return wire.Fail(wire.NoSession)
	}
	if s.media != nil {
		ready := s.media.Ready()
		s.mu.Unlock()
		if ready {
			return nil
		}
		return wire.Fail(wire.MediaRequired)
	}
	s.mu.Unlock()
	receiver, err := s.tunnel.ListenUDP(lifetime)
	if err != nil {
		return Classify(err, wire.MediaRequired)
	}
	s.mu.Lock()
	port := s.services.GetPort(DisplayService)
	s.mu.Unlock()
	if port < 1 || port > 65535 {
		receiver.Close()
		return wire.Fail(wire.ServiceMissing)
	}
	open := func(ctx context.Context) (MediaControl, error) {
		conn, err := s.tunnel.DialTCP(ctx, uint16(port))
		if err != nil {
			return nil, err
		}
		h, err := http.NewHttpConnection(conn)
		if err != nil {
			conn.Close()
			return nil, err
		}
		x, err := ios.CreateXpcConnection(h)
		if err != nil {
			h.Close()
			return nil, err
		}
		return display.NewWithConnection(x), nil
	}
	media, err := StartMedia(request, receiver, s.tunnel.RemoteIP, open)
	if err != nil {
		return err
	}
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return errors.Join(wire.Fail(wire.NoSession), media.Close())
	}
	s.media = media
	s.mu.Unlock()
	go func() {
		select {
		case <-media.Done():
			_ = s.Close()
		case <-s.tunnel.Done():
			_ = media.Close()
		}
	}()
	return nil
}
