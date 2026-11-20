package wire

import (
	"encoding/json"
	"os"
	"testing"
)

func TestSetupGoldensAndImageRootBounds(t *testing.T) {
	data, err := os.ReadFile("../../testdata/ipc-setup-golden.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixtures []json.RawMessage
	if err = json.Unmarshal(data, &fixtures); err != nil {
		t.Fatal(err)
	}
	for i, fixture := range fixtures {
		if i%2 == 0 {
			if _, err = DecodeRequest(fixture); err != nil {
				t.Fatal(err)
			}
		} else {
			var response Response
			if err = StrictDecode(fixture, &response); err != nil {
				t.Fatal(err)
			}
		}
	}
	for _, raw := range []string{`null`, `[""]`, `["a","a","a","a","a","a","a","a","a"]`} {
		for _, method := range []string{"init", "images.refresh"} {
			params := `{"imageRoots":` + raw + `}`
			if method == "init" {
				params = `{"privateRoot":"/private/root","imageRoots":` + raw + `}`
			}
			if _, err := Params(Request{Method: method, Params: json.RawMessage(params)}); err == nil {
				t.Fatalf("accepted %s roots %s", method, raw)
			}
		}
	}
	for _, method := range []string{"setup.prepareDeveloperServices", "binding.probe", "session.open"} {
		params := `{"localPhoneId":"p","nativeEpoch":1}`
		if method == "binding.probe" {
			params = `{"bindingToken":"tok"}`
		} else if method == "session.open" {
			params = `{"bindingToken":"tok","sessionId":"s","runId":"r","access":"observe"}`
		}
		raw := `{"kind":"request","protocolVersion":1,"id":1,"timeoutMs":120000,"method":"` + method + `","params":` + params + `}`
		if _, err := DecodeRequest([]byte(raw)); err != nil {
			t.Fatalf("rejected 120s mount budget for %s: %v", method, err)
		}
	}
	if _, err := DecodeRequest([]byte(`{"kind":"request","protocolVersion":1,"id":1,"timeoutMs":120000,"method":"setup.inspect","params":{"localPhoneId":"p","nativeEpoch":1}}`)); err == nil {
		t.Fatal("accepted 120s timeout for non-mounting setup.inspect")
	}
}
