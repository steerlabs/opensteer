package wire

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"
)

func TestWifiGoldenMessages(t *testing.T) {
	data, err := os.ReadFile("../../testdata/ipc-wifi-golden.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixtures []json.RawMessage
	if err := json.Unmarshal(data, &fixtures); err != nil {
		t.Fatal(err)
	}
	expected := []interface{}{}
	for i, method := range []string{"setup.enableWifi", "setup.disableWifi", "setup.pairWifi"} {
		params, _ := json.Marshal(PhoneRef{"fixture-phone", 3})
		expected = append(expected, Request{Kind: "request", ProtocolVersion: 1, ID: uint64(i + 3), TimeoutMs: 10000, Method: method, Params: params})
	}
	expected = append(expected, Response{Kind: "response", ID: 5, Result: Roster{Revision: 4, Candidates: []Candidate{{LocalPhoneID: "fixture-phone", NativeEpoch: 3, Name: "iPhone", Transport: "wifi", Reason: WifiPhoneNotFound}}}})
	for i, reason := range []Reason{WifiNotEnabled, LocalNetworkPermissionRequired, WifiPhoneNotFound, WifiPairingRequired, WifiTransportUnsupported, WifiIdentityMismatch} {
		expected = append(expected, Response{Kind: "response", ID: uint64(i + 6), Result: ErrorResult{Error: Fail(reason)}})
	}
	if len(fixtures) != len(expected) {
		t.Fatal("Wi-Fi fixture count changed")
	}
	for i, fixture := range fixtures {
		encoded, err := json.Marshal(expected[i])
		if err != nil {
			t.Fatal(err)
		}
		var got, want interface{}
		if json.Unmarshal(fixture, &want) != nil || json.Unmarshal(encoded, &got) != nil {
			t.Fatal("invalid fixture")
		}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("Go/TS fixture %d disagrees", i)
		}
		if _, ok := expected[i].(Request); ok {
			if _, err := DecodeRequest(fixture); err != nil {
				t.Fatal(err)
			}
		}
	}
}
