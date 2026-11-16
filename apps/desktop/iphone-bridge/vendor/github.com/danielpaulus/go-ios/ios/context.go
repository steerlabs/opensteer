package ios

import (
	"context"
	"net"
	"time"
)

type LockdownError struct{ Code string }

func (e *LockdownError) Error() string { return "lockdown request rejected" }

type PairRecordError struct{ Number uint32 }

func (e *PairRecordError) Error() string { return "pair record unavailable" }
func (d DeviceEntry) ContextOrBackground() context.Context {
	if d.Context != nil {
		return d.Context
	}
	return context.Background()
}
func NewUsbMuxConnectionContext(ctx context.Context) (*UsbMuxConnection, error) {
	c, err := (&net.Dialer{}).DialContext(ctx, "unix", "/var/run/usbmuxd")
	if err != nil {
		return nil, err
	}
	wrapped := NewDeviceConnectionWithConn(c)
	wrapped.stop = context.AfterFunc(ctx, func() { _ = c.Close() })
	if deadline, ok := ctx.Deadline(); ok {
		_ = c.SetDeadline(deadline)
	}
	return NewUsbMuxConnection(wrapped), nil
}
func ReadPairRecordContext(ctx context.Context, udid string) (PairRecord, error) {
	c, err := NewUsbMuxConnectionContext(ctx)
	if err != nil {
		return PairRecord{}, err
	}
	defer c.Close()
	return c.ReadPair(udid)
}

func (c *DeviceConnection) BindContext(ctx context.Context) {
	if c.stop != nil {
		c.stop()
	}
	deadline := time.Time{}
	if d, ok := ctx.Deadline(); ok {
		deadline = d
	}
	_ = c.c.SetDeadline(deadline)
	raw := c.c
	c.stop = context.AfterFunc(ctx, func() { _ = raw.Close() })
}
