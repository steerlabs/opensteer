package phone

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"testing"

	"github.com/steerlabs/opensteer/iphone-bridge/internal/wire"
)

func realDeviceInfo(t *testing.T) map[string]interface{} {
	t.Helper()
	data, err := os.ReadFile("../../testdata/real-device-info.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture map[string]interface{}
	if err = json.Unmarshal(data, &fixture); err != nil {
		t.Fatal(err)
	}
	return fixture
}

// iPhone19,4 was captured through devicectl; its raw XPC shape is unverified.
func TestRealMultiDisplayState(t *testing.T) {
	for _, rotation := range []string{"rot0", "rot90", "rot180", "rot270"} {
		t.Run(rotation, func(t *testing.T) {
			f := realDeviceInfo(t)
			display := f["displays"].(map[string]interface{})
			displays := display["displays"].([]interface{})
			active := displays[1].(map[string]interface{})
			active["currentOrientation"] = rotation
			calls := 0
			opener := func(context.Context, string) (xpcChannel, error) {
				calls++
				return &stateReplies{outputs: []map[string]interface{}{display}}, nil
			}
			state, err := readDeviceState(context.Background(), opener, fixtureLock("locked"))
			if err != nil {
				t.Fatal(err)
			}
			want := map[string]int{"rot0": 0, "rot90": 90, "rot180": 180, "rot270": 270}[rotation]
			if calls != 1 {
				t.Fatalf("state opened %d device-info connections", calls)
			}
			if state.DisplayID != 2 || state.uniqueID != "123-456-789" || state.Display != "off" || state.Lock != "locked" || state.Rotation == nil || *state.Rotation != want {
				t.Fatalf("wrong state: %+v", state)
			}
			active["active"] = false
			delete(displays[0].(map[string]interface{}), "backlightState")
			display["backlightState"] = "on"
			state, err = readDeviceState(context.Background(), opener, fixtureLock("locked"))
			if err != nil {
				t.Fatal(err)
			}
			if state.DisplayID != 1 || state.Display != "on" {
				t.Fatalf("primary fallback: %+v", state)
			}
			displays[0].(map[string]interface{})["bounds"] = []interface{}{[]interface{}{0, 0}, []interface{}{100, 200}}
			changed, err := readDeviceState(context.Background(), opener, fixtureLock("locked"))
			if err != nil {
				t.Fatal(err)
			}
			if state.same(changed) {
				t.Fatal("bounds change could reuse screenshot geometry")
			}

		})
	}
}

type stateReplies struct {
	fixtureChannel
	outputs []map[string]interface{}
}

func (c *stateReplies) ReceiveOnServerClientStream() (map[string]interface{}, error) {
	reply := c.outputs[0]
	c.outputs = c.outputs[1:]
	return map[string]interface{}{"CoreDevice.output": reply}, nil
}

func TestRealSelectedDisplayFeedsCaptureAndIndigo(t *testing.T) {
	f := realDeviceInfo(t)
	display := f["displays"].(map[string]interface{})
	display["displays"].([]interface{})[1].(map[string]interface{})["backlightState"] = "on"
	state, err := readDeviceState(context.Background(), func(context.Context, string) (xpcChannel, error) {
		return &stateReplies{outputs: []map[string]interface{}{display}}, nil
	}, fixtureLock("unlocked"))
	if err != nil {
		t.Fatal(err)
	}
	s, b, p := screenFixture(t)
	b.state = state
	include := false
	result, err := s.observe(context.Background(), &wire.ObserveParams{ScreenRef: p.ScreenRef, IncludeScreenshot: &include}, okay)
	if err != nil {
		t.Fatal(err)
	}
	o := result.(*Observation)
	p.ObservationToken = o.ObservationToken
	p.GeometryRevision = o.GeometryRevision
	if b.captureDisplay != "123-456-789" || o.Geometry.DisplayID != 2 {
		t.Fatal("capture used another display")
	}
	if _, err = s.perform(context.Background(), p, okay, noWait); err != nil {
		t.Fatal(err)
	}
	for _, event := range b.channel.sent {
		if event["payload"].(map[string]interface{})["target"] != uint64(2) {
			t.Fatal("Indigo used another display")
		}
	}
}
func TestExternalOrUnaddressableActiveDisplayIsUnsupported(t *testing.T) {
	for _, change := range []func(map[string]interface{}){
		func(d map[string]interface{}) { d["external"] = true }, func(d map[string]interface{}) {
			d["type"] = map[string]interface{}{"external": map[string]interface{}{}}
		}, func(d map[string]interface{}) { delete(d, "uniqueId") },
	} {
		f := realDeviceInfo(t)
		display := f["displays"].(map[string]interface{})
		change(display["displays"].([]interface{})[1].(map[string]interface{}))
		if _, err := selectDisplay(display); err == nil {
			t.Fatal("silently selected an inactive display")
		}
	}
}

// This fixture preserves the raw XPC keys and all seven displays from iPhone18,2,
// iOS 27.0.1 (24A446); framebufferMaskIdentifier is redacted.
func rawDisplayInfo(t *testing.T) map[string]interface{} {
	t.Helper()
	data, err := os.ReadFile("../../testdata/raw-getdisplayinfo-iphone18-2.json")
	if err != nil {
		t.Fatal(err)
	}
	var output map[string]interface{}
	if err := json.Unmarshal(data, &output); err != nil {
		t.Fatal(err)
	}
	for _, value := range output["displays"].([]interface{}) {
		d := value.(map[string]interface{})
		d["displayId"] = uint64(d["displayId"].(float64))
	}
	return output
}
func TestRawPrimaryDisplayWithoutUniqueID(t *testing.T) {
	output := rawDisplayInfo(t)
	selected, err := selectDisplay(output)
	if err != nil {
		t.Fatal(err)
	}
	if selected["name"] != "LCD" || selected["displayId"] != uint64(1) {
		t.Fatalf("selected placeholder: %+v", selected)
	}
}
func TestUnsignedWireNumbers(t *testing.T) {
	for _, value := range []interface{}{uint64(3), int64(3), int(3), float64(3)} {
		if n, ok := unsigned(value); !ok || n != 3 {
			t.Fatalf("rejected %T %v", value, value)
		}
	}
	for _, value := range []interface{}{float64(-1), float64(1.5), math.NaN(), math.Inf(1), math.Exp2(64), int64(-1), "3", nil} {
		if _, ok := unsigned(value); ok {
			t.Fatalf("accepted invalid number %T %v", value, value)
		}
	}
}

func fixtureLock(state string) func(context.Context) string {
	return func(context.Context) string { return state }
}
func TestRawBacklightStatesAndDisplayChanges(t *testing.T) {
	for _, backlight := range []string{"activeOn", "on", "inactiveOn", "off", "unexpected"} {
		t.Run(backlight, func(t *testing.T) {
			output := rawDisplayInfo(t)
			d := output["displays"].([]interface{})[0].(map[string]interface{})
			d["backlightState"] = backlight
			c := &fixtureChannel{reply: map[string]interface{}{"CoreDevice.output": output}}
			open := func(context.Context, string) (xpcChannel, error) { return c, nil }
			before, err := readDeviceState(context.Background(), open, fixtureLock("unlocked"))
			if err != nil {
				t.Fatal(err)
			}
			want := map[string]string{"activeOn": "on", "on": "on", "inactiveOn": "off", "off": "off", "unexpected": "unknown"}[backlight]
			if before.Display != want {
				t.Fatalf("display=%s want=%s", before.Display, want)
			}
			if len(c.sent) != 1 || c.sent[0]["CoreDevice.featureIdentifier"] != "com.apple.coredevice.feature.getdisplayinfo" {
				t.Fatal("deviceinfo received a lock-state request")
			}
			for _, key := range []string{"bounds", "frame", "nativeSize", "pointScale"} {
				original := d[key]
				if key == "pointScale" {
					d[key] = float64(2)
				} else {
					d[key] = []interface{}{float64(100), float64(200)}
				}
				after, err := readDeviceState(context.Background(), open, fixtureLock("unlocked"))
				if err != nil || before.same(after) {
					t.Fatalf("%s change reused geometry: %v", key, err)
				}
				d[key] = original
			}
		})
	}
}
func TestInvalidIntegratedDisplayIsUnsupported(t *testing.T) {
	for name, change := range map[string]func(map[string]interface{}){
		"zero size":       func(d map[string]interface{}) { d["nativeSize"] = []interface{}{float64(0), float64(2868)} },
		"fractional size": func(d map[string]interface{}) { d["nativeSize"] = []interface{}{float64(1.5), float64(2868)} },
		"wireless": func(d map[string]interface{}) {
			d["type"] = map[string]interface{}{"wireless": map[string]interface{}{}}
		},
		"missing type": func(d map[string]interface{}) { delete(d, "type") },
		"no primary":   func(d map[string]interface{}) { delete(d, "primary") },
		"unsafe id":    func(d map[string]interface{}) { d["displayId"] = uint64(9007199254740992) },
	} {
		t.Run(name, func(t *testing.T) {
			output := rawDisplayInfo(t)
			change(output["displays"].([]interface{})[0].(map[string]interface{}))
			if _, err := selectDisplay(output); err == nil {
				t.Fatal("accepted unsupported display")
			}
		})
	}
}
func TestRawPrimaryFeedsCaptureAndIndigo(t *testing.T) {
	output := rawDisplayInfo(t)
	c := &fixtureChannel{reply: map[string]interface{}{"CoreDevice.output": output}}
	state, err := readDeviceState(context.Background(), func(context.Context, string) (xpcChannel, error) { return c, nil }, fixtureLock("unlocked"))
	if err != nil {
		t.Fatal(err)
	}
	s, b, p := screenFixture(t)
	b.state = state
	include := false
	result, err := s.observe(context.Background(), &wire.ObserveParams{ScreenRef: p.ScreenRef, IncludeScreenshot: &include}, okay)
	if err != nil {
		t.Fatal(err)
	}
	o := result.(*Observation)
	p.ObservationToken, p.GeometryRevision = o.ObservationToken, o.GeometryRevision
	if b.captureDisplay != "" || o.Geometry.DisplayID != uint64(1) {
		t.Fatal("capture did not select main display")
	}
	if _, err := s.perform(context.Background(), p, okay, noWait); err != nil {
		t.Fatal(err)
	}
	for _, event := range b.channel.sent {
		if event["payload"].(map[string]interface{})["target"] != uint64(1) {
			t.Fatal("Indigo did not select primary numeric display id")
		}
	}
}
func TestNativeCaptureRawReply(t *testing.T) {
	for _, display := range []string{"", "123-456-789"} {
		t.Run(fmt.Sprint(display), func(t *testing.T) {
			c := &fixtureChannel{reply: map[string]interface{}{"CoreDevice.output": map[string]interface{}{"image": []byte("png bytes"), "imageFormat": "png", "displayUniqueID": display}}}
			n := nativeScreen{open: func(context.Context, string) (xpcChannel, error) { return c, nil }}
			data, err := n.Capture(context.Background(), display)
			if err != nil || string(data) != "png bytes" {
				t.Fatalf("raw capture: %s %v", data, err)
			}
			input := c.sent[0]["CoreDevice.input"].(map[string]interface{})
			id, present := input["displayUniqueID"]
			if (display != "") != present || (present && id != display) {
				t.Fatal("wrong capture display target")
			}
			c.reply = map[string]interface{}{"CoreDevice.output": map[string]interface{}{"image": []byte{}}}
			if _, err = n.Capture(context.Background(), display); err == nil {
				t.Fatal("accepted empty screenshot")
			}
		})
	}
}
