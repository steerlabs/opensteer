package phone

import (
	"context"
	"encoding/json"
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
	for _, value := range fixture["displays"].(map[string]interface{})["displays"].([]interface{}) {
		d := value.(map[string]interface{})
		d["displayId"] = uint64(d["displayId"].(float64))
	}
	return fixture
}
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
				return &stateReplies{outputs: []map[string]interface{}{f["lockState"].(map[string]interface{}), display}}, nil
			}
			state, err := readDeviceState(context.Background(), opener)
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
			state, err = readDeviceState(context.Background(), opener)
			if err != nil {
				t.Fatal(err)
			}
			if state.DisplayID != 1 || state.Display != "on" {
				t.Fatalf("primary fallback: %+v", state)
			}
			displays[0].(map[string]interface{})["bounds"] = []interface{}{[]interface{}{0, 0}, []interface{}{100, 200}}
			changed, err := readDeviceState(context.Background(), opener)
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
	lock := f["lockState"].(map[string]interface{})
	lock["passcodeRequired"] = false
	display["displays"].([]interface{})[1].(map[string]interface{})["backlightState"] = "on"
	state, err := readDeviceState(context.Background(), func(context.Context, string) (xpcChannel, error) {
		return &stateReplies{outputs: []map[string]interface{}{lock, display}}, nil
	})
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
