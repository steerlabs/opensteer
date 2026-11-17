package opack

import "testing"

func TestPairingInfoReferencesAndUnknownScalarFields(t *testing.T) {
	// Newly authored OPACK dictionary: model="fixture", name references the model,
	// and a numeric field is irrelevant to identity but still consumes its value.
	data := append([]byte{0xe3, 0x45}, []byte("model")...)
	data = append(data, 0x47)
	data = append(data, []byte("fixture")...)
	data = append(data, 0x44)
	data = append(data, []byte("name")...)
	data = append(data, 0xa1, 0x44)
	data = append(data, []byte("seen")...)
	data = append(data, 0x30, 100)
	values, err := DecodePairingInfo(data)
	if err != nil {
		t.Fatal(err)
	}
	if values["name"] != "fixture" {
		t.Fatal("pairing info reference lost")
	}
	for _, bad := range [][]byte{{0xe1, 0xa0}, {0xef, 0x41, 'a', 0x41, 'b'}, append(data, 0)} {
		if _, err := DecodePairingInfo(bad); err == nil {
			t.Fatal("malformed pairing info accepted")
		}
	}
}
