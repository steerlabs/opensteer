package wire

import "testing"

func TestScreenRequestBoundary(t *testing.T) {
	prefix := `{"kind":"request","protocolVersion":1,"id":3,"timeoutMs":1000,"method":"phone.perform","params":{"bindingToken":"b","sessionId":"s","nativeEpoch":1,"observationToken":"o","geometryRevision":1,"actions":`
	for _, action := range []string{`[{"kind":"navigate","button":"back"}]`, `[{"kind":"tap","target":{"point":{"x":-1,"y":0}}}]`, `[{"kind":"type","text":"x","extra":true}]`, `[]`} {
		if _, err := DecodeRequest([]byte(prefix + action + `}}`)); err == nil {
			t.Fatalf("accepted invalid actions %s", action)
		}
	}
	if _, err := DecodeRequest([]byte(prefix + `[{"kind":"tap","target":{"point":{"x":0,"y":0}}}]}}`)); err != nil {
		t.Fatal(err)
	}
}
