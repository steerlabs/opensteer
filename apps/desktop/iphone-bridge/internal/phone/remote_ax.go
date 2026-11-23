package phone

import (
	"context"
	"errors"
	"net"
	"time"

	dtx "github.com/danielpaulus/go-ios/ios/dtx_codec"
	"github.com/danielpaulus/go-ios/ios/nskeyedarchiver"
	"github.com/steerlabs/opensteer/iphone-bridge/internal/wire"
)

const remoteAXService = "com.apple.accessibility.axAuditDaemon.remoteserver"

func axCall(id int, selector string, argument interface{}) ([]byte, error) {
	payload, e := nskeyedarchiver.ArchiveBin(selector)
	if e != nil {
		return nil, e
	}
	data, e := nskeyedarchiver.ArchiveBin(argument)
	if e != nil {
		return nil, e
	}
	aux := dtx.NewPrimitiveDictionary()
	aux.AddBytes(data)
	return dtx.Encode(id, 0, 0, false, dtx.Methodinvocation, payload, aux)
}
func collectRemoteAX(ctx context.Context, dial ServiceDialer) (AXSnapshot, error) {
	ctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	life, end := context.WithDeadline(context.WithoutCancel(ctx), time.Now().Add(8500*time.Millisecond))
	defer end()
	stopDial := context.AfterFunc(ctx, end)
	raw, err := dial.DialService(life, remoteAXService)
	if err != nil {
		raw, err = dial.DialService(life, legacyAXShim)
	}
	stopDial()
	if err != nil {
		return AXSnapshot{}, Classify(err, wire.AccessibilityUnavailable)
	}
	conn := dtx.NewRawConnection(raw)
	defer conn.Close()
	stop := context.AfterFunc(ctx, func() { _ = conn.SetReadDeadline(time.Now()) })
	defer stop()
	defer func() {
		_ = conn.SetWriteDeadline(time.Now().Add(500 * time.Millisecond))
		b, e := axCall(3, "clientNeedsAccessibility:", false)
		if e == nil {
			_ = conn.Send(b)
		}
	}()
	send := func(id int, selector string, arg interface{}) error {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		d, _ := ctx.Deadline()
		_ = conn.SetWriteDeadline(d)
		b, e := axCall(id, selector, arg)
		if e != nil {
			return e
		}
		return conn.Send(b)
	}
	if err = send(1, "_notifyOfPublishedCapabilities:", map[string]interface{}{"com.apple.private.DTXBlockCompression": uint64(0), "com.apple.private.DTXConnection": uint64(1)}); err != nil {
		return AXSnapshot{}, wire.Fail(wire.AccessibilityUnavailable)
	}
	if err = send(2, "clientNeedsAccessibility:", true); err != nil {
		return AXSnapshot{}, wire.Fail(wire.AccessibilityUnavailable)
	}
	tree := newAXTree()
	deadline, _ := ctx.Deadline()
	quiet := time.Time{}
	reason := "message-limit"
	aggregate := 0
	for range 4096 {
		if ctx.Err() != nil {
			reason = "capture-deadline"
			break
		}
		until := deadline
		if !quiet.IsZero() && quiet.Before(until) {
			until = quiet
		}
		if err = conn.SetReadDeadline(until); err != nil {
			return AXSnapshot{}, wire.Fail(wire.AccessibilityUnavailable)
		}
		if ctx.Err() != nil {
			break
		}
		message, e := conn.Read()
		if e != nil {
			var timeout net.Error
			if errors.As(e, &timeout) && timeout.Timeout() {
				if !quiet.IsZero() && !time.Now().Before(quiet) {
					reason = "quiet-window"
				} else {
					reason = "capture-deadline"
				}
				break
			}
			if tree.usable() {
				reason = "transport-ended"
				break
			}
			return AXSnapshot{}, wire.Fail(wire.AccessibilityUnavailable)
		}
		aggregate += len(message.RawBytes)
		if aggregate > 16<<20 {
			reason = "byte-limit"
			break
		}
		if message.ExpectsReply {
			_ = conn.SetWriteDeadline(deadline)
			if err = conn.Send(dtx.BuildAckMessage(message)); err != nil {
				return AXSnapshot{}, wire.Fail(wire.AccessibilityUnavailable)
			}
		}
		if message.HasError() {
			return AXSnapshot{}, wire.Fail(wire.AccessibilityUnavailable)
		}
		previous := tree.revision
		for _, arg := range message.Auxiliary.GetArguments() {
			if data, ok := arg.([]byte); ok {
				if err = tree.archive(data); err != nil {
					return AXSnapshot{}, err
				}
			}
		}
		if tree.usable() && (tree.revision != previous || quiet.IsZero()) {
			quiet = time.Now().Add(600 * time.Millisecond)
		}
	}
	if !tree.usable() {
		return AXSnapshot{}, wire.Fail(wire.AccessibilityUnavailable)
	}
	return tree.snapshot(reason), nil
}
