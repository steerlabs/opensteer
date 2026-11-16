package phone

import (
	"context"
	"reflect"

	"github.com/danielpaulus/go-ios/ios/coredevice"
	"github.com/danielpaulus/go-ios/ios/xpc"
	"github.com/google/uuid"
	"github.com/steerlabs/opensteer/iphone-bridge/internal/wire"
)

const deviceInfoService = "com.apple.coredevice.deviceinfo"

type xpcChannel interface {
	Send(map[string]interface{}, ...uint32) error
	ReceiveOnServerClientStream() (map[string]interface{}, error)
	Close() error
}
type channelOpener func(context.Context, string) (xpcChannel, error)
type DeviceState struct {
	Lock      string `json:"lock"`
	Display   string `json:"display"`
	Rotation  *int   `json:"rotation"`
	DisplayID uint64 `json:"displayId"`
	uniqueID  string
}

func unknownState() DeviceState { return DeviceState{Lock: "unknown", Display: "unknown"} }
func (s DeviceState) safe() error {
	if s.Lock == "locked" {
		return wire.Fail(wire.PhoneLocked)
	}
	if s.Lock != "unlocked" {
		return wire.Fail(wire.LockUnknown)
	}
	if s.Display != "on" {
		return wire.Fail(wire.WakeRequired)
	}
	return nil
}
func (s DeviceState) same(t DeviceState) bool { return reflect.DeepEqual(s, t) }
func exchange(ctx context.Context, open channelOpener, service string, request map[string]interface{}, before func() error, effect bool) (map[string]interface{}, error) {
	if err := ctx.Err(); err != nil {
		return nil, Classify(err, wire.NativeServiceFailed)
	}
	conn, err := open(ctx, service)
	if err != nil {
		return nil, Classify(err, wire.NativeServiceFailed)
	}
	defer conn.Close()
	stop := context.AfterFunc(ctx, func() { _ = conn.Close() })
	defer stop()
	if before != nil {
		if err := before(); err != nil {
			return nil, err
		}
	}
	if err := ctx.Err(); err != nil {
		return nil, Classify(err, wire.NativeServiceFailed)
	}
	failure := func(err error) error {
		if effect {
			return &wire.Failure{Code: wire.OutcomeUnknown, Effect: "unknown"}
		}
		return Classify(err, wire.NativeServiceFailed)
	}
	if err := conn.Send(request, xpc.HeartbeatRequestFlag); err != nil {
		return nil, failure(err)
	}
	reply, err := conn.ReceiveOnServerClientStream()
	if err != nil {
		return nil, failure(err)
	}
	if err := coredevice.ResponseError(reply); err != nil {
		return nil, wire.Fail(wire.NativeServiceFailed)
	}
	output, ok := reply["CoreDevice.output"].(map[string]interface{})
	if !ok {
		return nil, failure(wire.Fail(wire.ProtocolUnsupported))
	}
	return output, nil
}
func readDeviceState(ctx context.Context, open channelOpener) (DeviceState, error) {
	state := unknownState()
	lock, err := exchange(ctx, open, deviceInfoService, coredevice.BuildRequest(uuid.New().String(), "com.apple.coredevice.feature.getlockstate", map[string]interface{}{}), nil, false)
	if err != nil {
		return state, err
	}
	// CoreDevice reports present passcode demand and whether first unlock occurred;
	// neither field describes whether a passcode is configured.
	required, hasRequired := lock["passcodeRequired"].(bool)
	unlocked, hasUnlocked := lock["unlockedSinceBoot"].(bool)
	if hasRequired && required {
		state.Lock = "locked"
	}
	if hasRequired && !required && hasUnlocked && unlocked {
		state.Lock = "unlocked"
	}
	display, err := exchange(ctx, open, deviceInfoService, coredevice.BuildRequest(uuid.New().String(), "com.apple.coredevice.feature.getdisplayinfo", map[string]interface{}{}), nil, false)
	if err != nil {
		return state, err
	}
	displays, ok := display["displays"].([]interface{})
	if !ok || len(displays) != 1 {
		return state, wire.Fail(wire.DisplayUnsupported)
	}
	d, ok := displays[0].(map[string]interface{})
	if !ok {
		return state, wire.Fail(wire.DisplayUnsupported)
	}
	if external, _ := d["external"].(bool); external {
		return state, wire.Fail(wire.DisplayUnsupported)
	}
	id, ok := unsigned(d["displayId"])
	if !ok || id > 9007199254740991 {
		return state, wire.Fail(wire.DisplayUnsupported)
	}
	state.DisplayID = id
	state.uniqueID, _ = d["uniqueId"].(string)
	if active, ok := d["active"].(bool); ok {
		if active {
			state.Display = "on"
		} else {
			state.Display = "off"
		}
	}
	if rotation, ok := unsigned(d["rotation"]); ok && (rotation == 0 || rotation == 90 || rotation == 180 || rotation == 270) {
		r := int(rotation)
		state.Rotation = &r
	}
	return state, nil
}
func unsigned(v interface{}) (uint64, bool) {
	switch n := v.(type) {
	case uint64:
		return n, true
	case int64:
		if n >= 0 {
			return uint64(n), true
		}
	case int:
		if n >= 0 {
			return uint64(n), true
		}
	}
	return 0, false
}
