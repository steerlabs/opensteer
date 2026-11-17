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
}
