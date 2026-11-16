package phone

import (
	"context"

	"github.com/danielpaulus/go-ios/ios/xpc"
	"github.com/steerlabs/opensteer/iphone-bridge/internal/wire"
)

// Indigo's keyboard usage page is implicit. Unicode insertion and field clearing
// require separate focus/layout/secure-field qualification before they can use it.
func keyboardPayload(usage, state uint64) map[string]interface{} {
	return map[string]interface{}{"featureIdentifier": "com.apple.coredevice.feature.remote.hid.keyboard", "messageType": "IndigoKeyboardButtonEvent", "payload": map[string]interface{}{"usageCode": usage, "state": state}}
}

type keyboard struct {
	conn xpcChannel
	held []uint64
}

func (k *keyboard) down(ctx context.Context, usage uint64, guard func() error) error {
	if usage < 4 || usage > 0xe7 {
		return wire.Fail(wire.UnsupportedText)
	}
	if err := ctx.Err(); err != nil {
		return Classify(err, wire.Cancelled)
	}
	if err := guard(); err != nil {
		return err
	}
	for _, key := range k.held {
		if key == usage {
			return wire.Fail(wire.ProtocolUnsupported)
		}
	}
	k.held = append(k.held, usage)
	if err := k.conn.Send(keyboardPayload(usage, 1), xpc.HeartbeatRequestFlag); err != nil {
		return &wire.Failure{Code: wire.OutcomeUnknown, Effect: "unknown"}
	}
	return nil
}
func (k *keyboard) release() error {
	var failed bool
	for i := len(k.held) - 1; i >= 0; i-- {
		if err := k.conn.Send(keyboardPayload(k.held[i], 2), xpc.HeartbeatRequestFlag); err != nil {
			failed = true
		}
	}
	k.held = nil
	if failed {
		return &wire.Failure{Code: wire.OutcomeUnknown, Effect: "unknown"}
	}
	return nil
}

func keyboardChord(ctx context.Context, conn xpcChannel, usages []uint64, guard func() error) (err error) {
	if len(usages) < 1 || len(usages) > 8 {
		return wire.Fail(wire.UnsupportedText)
	}
	seen := map[uint64]bool{}
	for _, usage := range usages {
		if usage < 4 || usage > 0xe7 || seen[usage] {
			return wire.Fail(wire.UnsupportedText)
		}
		seen[usage] = true
	}
	keys := keyboard{conn: conn}
	submitted := false
	defer func() {
		if releaseErr := keys.release(); releaseErr != nil {
			err = releaseErr
		} else if err != nil {
			failure := Classify(err, wire.NativeServiceFailed)
			if submitted && failure.Effect == "not-started" {
				err = &wire.Failure{Code: failure.Code, Effect: "submitted"}
			}
		}
	}()
	for _, usage := range usages {
		if err = keys.down(ctx, usage, guard); err != nil {
			return err
		}
		submitted = true
	}
	return nil
}
