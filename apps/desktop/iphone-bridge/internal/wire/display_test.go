package wire

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"testing"
)

const fixtureDisplayRef = `"bindingToken":"fixture-binding","nativeEpoch":2,"streamId":"dsp_c2a11f7c-8568-4d02-80ec-754ae26bb150"`

func TestDisplayFixtures(t *testing.T) {
	data, err := os.ReadFile("../../testdata/display-ipc-golden.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixtures []json.RawMessage
	if err := json.Unmarshal(data, &fixtures); err != nil {
		t.Fatal(err)
	}
	if len(fixtures) != 8 {
		t.Fatalf("got %d fixtures", len(fixtures))
	}
	for _, fixture := range fixtures[:7] {
		if _, err := DecodeRequest(fixture); err != nil {
			t.Fatal(err)
		}
	}
	var event Event
	if err := json.Unmarshal(fixtures[7], &event); err != nil || event.DisplayState == nil || event.Roster != nil {
		t.Fatal("invalid display state fixture")
	}
	var want bytes.Buffer
	if err := json.Compact(&want, fixtures[7]); err != nil {
		t.Fatal(err)
	}
	data, err = json.Marshal(event)
	if err != nil || string(data) != want.String() {
		t.Fatalf("display state shape differs: %s", data)
	}
}

func TestDisplayRequestsRejectMalformedParams(t *testing.T) {
	cases := []struct{ method, params string }{
		{"display.start", `"maxLongSide":319,"maxFps":60`},
		{"display.start", `"maxLongSide":1920,"maxFps":61`},
		{"display.start", `"maxLongSide":1920`},
		{"display.demand", `"maxFps":null`},
		{"display.demand", `"active":null`},
		{"display.refresh", `"sessionId":"unexpected"`},
		{"display.stop", `"streamId":"duplicate"`},
		{"display.power", `"action":"unlock"`},
		{"display.input", `"events":[]`},
		{"display.input", `"events":[{"kind":"pointer","phase":"down","x":0,"y":0}]`},
		{"display.input", `"events":[{"kind":"pointer","phase":"up","x":1.01,"y":0,"t":1}]`},
		{"display.input", `"events":[{"kind":"scroll","x":0,"y":0,"dx":0,"dy":-1.1}]`},
		{"display.input", `"events":[{"kind":"text","insert":"x","submit":true}]`},
		{"display.input", `"events":[{"kind":"text","submit":false}]`},
		{"display.input", `"events":[{"kind":"key","action":"down","code":"KeyX","key":"x","modifiers":["command"]}]`},
		{"display.input", `"events":[{"kind":"key","action":"down","code":"KeyX","key":"x","modifiers":[null]}]`},
		{"display.input", `"events":[{"kind":"command","command":"invalid","contextId":"00000000-0000-4000-8000-000000000001"}]`},
		{"display.input", `"events":[{"kind":"command","command":"selectAll"}]`},
		{"display.input", `"events":[{"kind":"copy"}]`},
		{"display.input", `"events":[{"kind":"paste","text":"fixture"}]`},
		{"display.input", `"events":[{"kind":"paste","items":[{"type":"text/plain"}]}]`},
	}
	for _, tc := range cases {
		t.Run(tc.method+tc.params, func(t *testing.T) {
			params := json.RawMessage(fmt.Sprintf("{%s,%s}", fixtureDisplayRef, tc.params))
			if _, err := Params(Request{Method: tc.method, Params: params}); err == nil {
				t.Fatal("malformed parameters accepted")
			}
		})
	}
	for _, tc := range []struct {
		name   string
		params string
		want   *bool
	}{
		{"active-false", `"active":false`, boolPtr(false)},
		{"active-true", `"maxFps":24,"active":true`, boolPtr(true)},
		{"active-omitted", `"maxFps":24`, nil},
	} {
		t.Run("display.demand/"+tc.name, func(t *testing.T) {
			raw := json.RawMessage(fmt.Sprintf("{%s,%s}", fixtureDisplayRef, tc.params))
			parsed, err := Params(Request{Method: "display.demand", Params: raw})
			if err != nil {
				t.Fatalf("valid demand rejected: %v", err)
			}
			demand := parsed.(*DisplayDemandParams)
			if (demand.Active == nil) != (tc.want == nil) || (tc.want != nil && *demand.Active != *tc.want) {
				t.Fatalf("got active=%v want=%v", demand.Active, tc.want)
			}
		})
	}
}

func boolPtr(v bool) *bool { return &v }

func TestExpandedActionValidation(t *testing.T) {
	valid := []string{
		`{"kind":"tap","count":2,"target":{"nodeId":"n1"}}`,
		`{"kind":"swipe","edge":"top","target":{"point":{"x":1,"y":0}},"to":{"x":1,"y":100},"durationMs":80}`,
		`{"kind":"pinch","scale":0.1,"target":{"nodeId":"n1"},"durationMs":1}`,
		`{"kind":"key","key":"Return","modifiers":["shift","option"]}`,
		`{"kind":"terminate","appId":"example.fixture"}`,
		`{"kind":"navigate","button":"quickSettings"}`,
	}
	invalid := []string{
		strings.Replace(valid[0], ":2", ":0", 1), strings.Replace(valid[1], `"top"`, `"auto"`, 1),
		strings.Replace(valid[2], "0.1", "10.1", 1), strings.Replace(valid[3], `"option"`, `"alt"`, 1),
		strings.Replace(valid[4], `"example.fixture"`, `""`, 1), strings.Replace(valid[5], `"quickSettings"`, `"back"`, 1),
	}
	for _, list := range []struct {
		cases []string
		want  bool
	}{{valid, true}, {invalid, false}} {
		for _, body := range list.cases {
			var action Action
			if err := json.Unmarshal([]byte(body), &action); (err == nil) != list.want {
				t.Errorf("%s: %v", body, err)
			}
		}
	}
}

func TestDisplayPrivacyEventsArePreservedBetweenRosterChanges(t *testing.T) {
	s := &Server{BootID: "fixture", eventReady: make(chan struct{}, 1)}
	s.Publish(Roster{Revision: 1})
	s.PublishDisplayState(DisplayStateEvent{State: "protected", Generation: 2})
	s.Publish(Roster{Revision: 2})
	s.Publish(Roster{Revision: 3})
	s.PublishDisplayState(DisplayStateEvent{State: "live", Generation: 3})
	for _, seq := range []uint64{1, 2, 3, 4} {
		<-s.eventReady
		event := s.nextEvent()
		if event.Sequence != seq || ((seq == 2 || seq == 4) != (event.DisplayState != nil)) {
			t.Fatalf("unexpected event %+v", event)
		}
		if seq == 3 && (event.Roster == nil || event.Roster.Revision != 3) {
			t.Fatalf("expected coalesced roster revision 3 at seq 3, got %+v", event)
		}
	}
}

func TestDisplayEventWakeAndPublishInterleaving(t *testing.T) {
	s := &Server{BootID: "fixture", eventReady: make(chan struct{}, 1)}
	s.Publish(Roster{Revision: 1})
	<-s.eventReady
	s.Publish(Roster{Revision: 2})
	if event := s.nextEvent(); event.Roster.Revision != 2 || len(s.eventReady) != 0 {
		t.Fatal("roster coalescing left the writer with a stale notification")
	}
	s.Publish(Roster{Revision: 3})
	<-s.eventReady
	s.PublishDisplayState(DisplayStateEvent{State: "protected"})
	if event := s.nextEvent(); event.Roster.Revision != 3 {
		t.Fatal("wrong event sequence")
	}
	<-s.eventReady
	if event := s.nextEvent(); event.DisplayState == nil || len(s.eventReady) != 0 {
		t.Fatal("privacy notification was lost")
	}
}
