package phone

import (
	"encoding/json"
	"github.com/steerlabs/opensteer/iphone-bridge/internal/wire"
	"os"
	"reflect"
	"testing"
)

func TestScreenGoTSGoldenFixtures(t *testing.T) {
	data, e := os.ReadFile("../../testdata/screen-ipc-golden.json")
	if e != nil {
		t.Fatal(e)
	}
	var fixtures []json.RawMessage
	if e = json.Unmarshal(data, &fixtures); e != nil {
		t.Fatal(e)
	}
	if len(fixtures) != 9 {
		t.Fatal("unexpected screen fixture count")
	}
	for _, data := range fixtures {
		var header struct {
			Kind   string
			ID     uint64
			Result json.RawMessage
		}
		if e = json.Unmarshal(data, &header); e != nil {
			t.Fatal(e)
		}
		if header.Kind == "request" {
			if _, e := wire.DecodeRequest(data); e != nil {
				t.Fatalf("request rejected: %v", e)
			}
			continue
		}
		var target interface{}
		switch header.ID {
		case 10:
			target = &Observation{}
		case 11:
			target = &PerformResult{}
		case 12:
			target = &InstalledApps{}
		case 13, 14:
			target = &wire.ErrorResult{}
		default:
			t.Fatal("unexpected fixture id")
		}
		if err := json.Unmarshal(header.Result, target); err != nil {
			t.Fatal(err)
		}
		encoded, err := json.Marshal(target)
		if err != nil {
			t.Fatal(err)
		}
		var a, b interface{}
		if json.Unmarshal(header.Result, &a) != nil || json.Unmarshal(encoded, &b) != nil || !reflect.DeepEqual(a, b) {
			t.Fatalf("Go/TS response differs: %s", encoded)
		}
	}
}
