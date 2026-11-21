package phone

import (
	"context"
	"encoding/json"
	"log/slog"
	"math"
	"reflect"
	"time"

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
	Lock          string `json:"lock"`
	Display       string `json:"display"`
	Rotation      *int   `json:"rotation"`
	DisplayID     uint64 `json:"displayId"`
	configuration string
	uniqueID      string
}

func unknownState() DeviceState { return DeviceState{Lock: "unknown", Display: "unknown"} }
func (s DeviceState) screenBlocker() wire.Reason {
	switch {
	case s.Lock == "locked":
		return wire.PhoneLocked
	case s.Lock != "unlocked":
		return wire.LockUnknown
	case s.Display == "off":
		return wire.WakeRequired
	case s.Display != "on":
		return wire.DisplayUnknown
	default:
		return ""
	}
}

func (s DeviceState) safe() error {
	if reason := s.screenBlocker(); reason != "" {
		return wire.Fail(reason)
	}
	return nil
}
func (s DeviceState) same(t DeviceState) bool { return reflect.DeepEqual(s, t) }
func exchange(ctx context.Context, open channelOpener, service string, request map[string]interface{}, before func() error, effect bool) (map[string]interface{}, error) {
	conn, err := open(ctx, service)
	if err != nil {
		return nil, Classify(err, wire.NativeServiceFailed)
	}
	defer conn.Close()
	return exchangeOn(ctx, conn, request, before, effect)
}
func exchangeOn(ctx context.Context, conn xpcChannel, request map[string]interface{}, before func() error, effect bool) (result map[string]interface{}, err error) {
	start := time.Now()
	defer func() {
		reason := ""
		if err != nil {
			reason = string(Classify(err, wire.NativeServiceFailed).Code)
		}
		feature, _ := request["CoreDevice.featureIdentifier"].(string)
		slog.Debug("bridge.service", "service", feature, "reason", reason, "durationMs", time.Since(start).Milliseconds())
	}()
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
		slog.Debug("bridge.native-error", "err", err)
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
		return nil, Classify(err, wire.NativeServiceFailed)
	}
	output, ok := reply["CoreDevice.output"].(map[string]interface{})
	if !ok {
		return nil, failure(wire.Fail(wire.ProtocolUnsupported))
	}
	return output, nil
}
func readDeviceState(ctx context.Context, open channelOpener, lock func(context.Context) string) (DeviceState, error) {
	state := unknownState()
	state.Lock = lock(ctx)
	conn, err := open(ctx, deviceInfoService)
	if err != nil {
		return state, Classify(err, wire.NativeServiceFailed)
	}
	defer conn.Close()
	display, err := exchangeOn(ctx, conn, coredevice.BuildRequest(uuid.New().String(), "com.apple.coredevice.feature.getdisplayinfo", map[string]interface{}{}), nil, false)
	if err != nil {
		return state, err
	}
	d, err := selectDisplay(display)
	if err != nil {
		return state, err
	}
	shape, err := json.Marshal([4]interface{}{d["bounds"], d["frame"], d["nativeSize"], d["pointScale"]})
	if err != nil {
		return state, wire.Fail(wire.GeometryUnavailable)
	}
	state.configuration = string(shape)
	state.DisplayID, _ = unsigned(d["displayId"])
	state.uniqueID, _ = d["uniqueId"].(string)
	backlight, _ := d["backlightState"].(string)
	if backlight == "" {
		backlight, _ = display["backlightState"].(string)
	}
	switch backlight {
	case "on", "activeOn":
		state.Display = "on"
	case "off", "inactiveOn":
		state.Display = "off"
	default:
		reading := "unrecognized"
		if backlight == "" {
			reading = "missing-or-non-string"
		}
		slog.Debug("bridge.screen-state", "lock", state.Lock, "display", state.Display, "reason", reading)
	}
	orientation, _ := d["currentOrientation"].(string)
	if r, ok := map[string]int{"rot0": 0, "rot90": 90, "rot180": 180, "rot270": 270}[orientation]; ok {
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
	case float64:
		if finite(n) && n >= 0 && n < math.Exp2(64) && math.Trunc(n) == n {
			return uint64(n), true
		}
	}
	return 0, false
}

func selectDisplay(output map[string]interface{}) (map[string]interface{}, error) {
	displays, ok := output["displays"].([]interface{})
	if !ok || len(displays) == 0 || len(displays) > 16 {
		return nil, wire.Fail(wire.DisplayUnsupported)
	}
	var active, primary map[string]interface{}
	for _, value := range displays {
		d, ok := value.(map[string]interface{})
		if !ok {
			continue
		}
		if inUse, _ := d["active"].(bool); inUse {
			if active != nil {
				return nil, wire.Fail(wire.DisplayUnsupported)
			}
			active = d
		}
		if main, _ := d["primary"].(bool); main {
			if primary != nil {
				return nil, wire.Fail(wire.DisplayUnsupported)
			}
			primary = d
		}
	}
	selected := active
	if selected == nil {
		selected = primary
	}
	if selected == nil || !usableDisplay(selected) {
		return nil, wire.Fail(wire.DisplayUnsupported)
	}
	return selected, nil
}
func usableDisplay(d map[string]interface{}) bool {
	external, _ := d["external"].(bool)
	kind, _ := d["type"].(map[string]interface{})
	_, integrated := kind["integrated"]
	if external || !integrated || len(kind) != 1 {
		return false
	}
	id, ok := unsigned(d["displayId"])
	if !ok || id > 9007199254740991 {
		return false
	}
	unique, _ := d["uniqueId"].(string)
	primary, _ := d["primary"].(bool)
	size, _ := d["nativeSize"].([]interface{})
	if len(size) != 2 {
		return false
	}
	width, widthOK := unsigned(size[0])
	height, heightOK := unsigned(size[1])
	return widthOK && heightOK && width > 0 && height > 0 && (primary || unique != "")
}
