package wire

import (
	"bytes"
	"encoding/binary"
	"io"
	"testing"
)

type shortReader struct{ io.Reader }

func (r shortReader) Read(p []byte) (int, error) { return r.Reader.Read(p[:min(1, len(p))]) }
func TestFrames(t *testing.T) {
	var b bytes.Buffer
	if err := WriteFrame(&b, map[string]string{"value": "한글"}, MaxRequestBytes); err != nil {
		t.Fatal(err)
	}
	data := append([]byte{}, b.Bytes()...)
	data = append(data, data...)
	r := shortReader{bytes.NewReader(data)}
	for range 2 {
		v, err := ReadFrame(r, MaxRequestBytes)
		if err != nil || !bytes.Contains(v, []byte("한글")) {
			t.Fatalf("frame: %q %v", v, err)
		}
	}
}
func TestMalformedFrames(t *testing.T) {
	for _, n := range []uint32{0, MaxRequestBytes + 1, 0xffffffff} {
		var b [4]byte
		binary.BigEndian.PutUint32(b[:], n)
		if _, err := ReadFrame(bytes.NewReader(b[:]), MaxRequestBytes); err == nil {
			t.Fatalf("accepted length %d", n)
		}
	}
	for _, data := range [][]byte{{0, 0}, {0, 0, 0, 2, '{'}, {0, 0, 0, 2, 0xff, 0xff}} {
		if _, err := ReadFrame(bytes.NewReader(data), MaxRequestBytes); err == nil {
			t.Fatalf("accepted %x", data)
		}
	}
}
func TestStrictRequests(t *testing.T) {
	good := `{"kind":"request","protocolVersion":1,"id":1,"timeoutMs":1000,"method":"hello","params":{}}`
	if _, err := DecodeRequest([]byte(good)); err != nil {
		t.Fatal(err)
	}
	for _, s := range []string{
		`{"kind":"request","protocolVersion":2,"id":1,"timeoutMs":1000,"method":"hello","params":{}}`,
		`{"kind":"request","protocolVersion":1,"id":1,"id":2,"timeoutMs":1000,"method":"hello","params":{}}`,
		`{"kind":"request","protocolVersion":1,"id":1,"timeoutMs":1000,"method":"hello","params":{"extra":true}}`,
		`{"kind":"request","protocolVersion":1,"id":1,"timeoutMs":1000,"method":"shell","params":{}}`,
		good + ` {}`,
	} {
		if _, err := DecodeRequest([]byte(s)); err == nil {
			t.Fatalf("accepted %s", s)
		}
	}
}
