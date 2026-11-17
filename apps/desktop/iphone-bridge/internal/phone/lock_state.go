package phone

import (
	"context"

	"github.com/danielpaulus/go-ios/ios"
)

const remoteLockdownService = "com.apple.mobile.lockdown.remote.trusted"

func remoteLockdown(device ios.DeviceEntry) (*ios.LockDownConnection, error) {
	conn, err := ios.ConnectToShimService(device, remoteLockdownService)
	if err != nil {
		return nil, err
	}
	return ios.NewLockDownConnection(conn), nil
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
