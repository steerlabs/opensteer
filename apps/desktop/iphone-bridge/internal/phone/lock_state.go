package phone

import (
	"context"
	"sync"
	"time"

	"github.com/danielpaulus/go-ios/ios"
	"github.com/steerlabs/opensteer/iphone-bridge/internal/wire"
)

const (
	remoteLockdownService = "com.apple.mobile.lockdown.remote.trusted"
	lockdownCallTimeout   = 2 * time.Second
)

func remoteLockdown(device ios.DeviceEntry) (*ios.LockDownConnection, error) {
	conn, err := ios.ConnectToShimService(device, remoteLockdownService)
	if err != nil {
		return nil, err
	}
	return ios.NewLockDownConnection(conn), nil
}

type lockdownOpener func(context.Context) (*ios.LockDownConnection, error)

// warmLockdown reuses a single Lockdown connection across monitor ticks instead
// of opening and tearing down a fresh usbmux/tunnel + plist session on every
// 200 ms poll. Admission is context-aware and each exchange is independently
// bounded so a stalled caller cannot block monitorDisplay past its deadline.
type warmLockdown struct {
	life     context.Context
	open     lockdownOpener
	initOnce sync.Once
	gate     chan struct{}
	connMu   sync.Mutex
	conn     *ios.LockDownConnection
	cancel   context.CancelFunc
	closed   bool
}

func (w *warmLockdown) init() {
	w.initOnce.Do(func() {
		w.gate = make(chan struct{}, 1)
	})
}

func (w *warmLockdown) acquire(ctx context.Context) bool {
	w.init()
	select {
	case w.gate <- struct{}{}:
		return true
	case <-ctx.Done():
		return false
	}
}

func (w *warmLockdown) release() {
	<-w.gate
}

func (w *warmLockdown) close() {
	w.connMu.Lock()
	w.closed = true
	conn, cancel := w.conn, w.cancel
	w.conn, w.cancel = nil, nil
	w.connMu.Unlock()
	if cancel != nil {
		cancel()
	}
	if conn != nil {
		conn.Close()
	}
}

func (w *warmLockdown) reset(target *ios.LockDownConnection) {
	w.connMu.Lock()
	var cancel context.CancelFunc
	if w.conn == target {
		w.conn = nil
		cancel = w.cancel
		w.cancel = nil
	}
	w.connMu.Unlock()
	if cancel != nil {
		cancel()
	}
	if target != nil {
		target.Close()
	}
}

func (w *warmLockdown) read(ctx context.Context) string {
	if w.open == nil || ctx.Err() != nil {
		return "unknown"
	}
	if !w.acquire(ctx) {
		return "unknown"
	}
	defer w.release()
	for attempt := range 2 {
		if ctx.Err() != nil {
			return "unknown"
		}
		callCtx, callCancel := context.WithTimeout(ctx, lockdownCallTimeout)
		w.connMu.Lock()
		closed := w.closed
		conn := w.conn
		w.connMu.Unlock()
		if closed {
			callCancel()
			return "unknown"
		}
		hadConn := conn != nil
		if conn == nil {
			base := w.life
			if base == nil {
				base = context.Background()
			}
			if base.Err() != nil {
				callCancel()
				return "unknown"
			}
			connCtx, connCancel := context.WithCancel(base)
			abortDial := context.AfterFunc(callCtx, connCancel)
			opened, err := w.open(connCtx)
			aborted := !abortDial()
			if err != nil {
				connCancel()
				callCancel()
				return "unknown"
			}
			if aborted || callCtx.Err() != nil {
				connCancel()
				opened.Close()
				callCancel()
				return "unknown"
			}
			w.connMu.Lock()
			if w.closed {
				w.connMu.Unlock()
				connCancel()
				opened.Close()
				callCancel()
				return "unknown"
			}
			w.conn, w.cancel = opened, connCancel
			conn = opened
			w.connMu.Unlock()
		}
		raw := conn.Conn()
		if raw != nil {
			deadline, _ := callCtx.Deadline()
			_ = raw.SetDeadline(deadline)
		}
		stop := context.AfterFunc(callCtx, func() {
			if raw != nil {
				_ = raw.Close()
			} else {
				conn.Close()
			}
		})
		// PasswordProtected is current passcode demand, not passcode configuration.
		value, err := conn.GetValue("PasswordProtected")
		aborted := !stop()
		if raw != nil {
			_ = raw.SetDeadline(time.Time{})
		}
		callErr := callCtx.Err()
		callCancel()
		if err == nil && !aborted && callErr == nil {
			if locked, ok := value.(bool); ok {
				if locked {
					return "locked"
				}
				return "unlocked"
			}
			w.reset(conn)
			return "unknown"
		}
		w.reset(conn)
		if !hadConn || attempt == 1 || aborted || callErr != nil || ctx.Err() != nil {
			return "unknown"
		}
	}
	return "unknown"
}

func (s *Session) openWarmLockdown(ctx context.Context) (*ios.LockDownConnection, error) {
	s.mu.Lock()
	closed, open := s.closed, s.openLockdown
	s.mu.Unlock()
	if closed || open == nil {
		return nil, wire.Fail(wire.NoSession)
	}
	return open(ctx)
}

func (s *Session) readLockState(ctx context.Context) string {
	s.mu.Lock()
	closed, open := s.closed, s.openLockdown
	s.mu.Unlock()
	if closed || open == nil || ctx.Err() != nil {
		return "unknown"
	}
	conn, err := open(ctx)
	if err != nil {
		return "unknown"
	}
	stop := context.AfterFunc(ctx, func() { _ = conn.Conn().Close() })
	defer stop()
	defer conn.Close()
	// PasswordProtected is current passcode demand, not passcode configuration.
	value, err := conn.GetValue("PasswordProtected")
	locked, ok := value.(bool)
	if err != nil || !ok || ctx.Err() != nil {
		return "unknown"
	}
	if locked {
		return "locked"
	}
	return "unlocked"
}
