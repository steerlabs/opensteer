package tunnel

import (
	"bytes"
	"encoding/binary"
	"io"
	"testing"
)

type fragmentReader struct{ io.Reader }

func (r fragmentReader) Read(p []byte) (int, error) { return r.Reader.Read(p[:min(1, len(p))]) }
func ipv6Fixture(payload []byte) []byte {
	b := make([]byte, 40+len(payload))
	b[0] = 0x60
	binary.BigEndian.PutUint16(b[4:6], uint16(len(payload)))
	copy(b[40:], payload)
	return b
}
func TestIPv6FragmentationAndCoalescing(t *testing.T) {
	a, b := ipv6Fixture([]byte("first")), ipv6Fixture([]byte("second"))
	data := append(append([]byte{}, a...), b...)
	for _, input := range []io.Reader{bytes.NewReader(data), fragmentReader{bytes.NewReader(data)}} {
		r := newFramedIPv6Reader(input)
		buf := make([]byte, 1280)
		for _, want := range [][]byte{a, b} {
			n, err := r.Read(buf)
			if err != nil || !bytes.Equal(buf[:n], want) {
				t.Fatalf("packet %x %v", buf[:n], err)
			}
		}
	}
}
func TestIPv6RejectsCorruption(t *testing.T) {
	wrongVersion := ipv6Fixture(nil)
	wrongVersion[0] = 0x40
	oversized := ipv6Fixture(nil)
	binary.BigEndian.PutUint16(oversized[4:6], 1241)
	truncated := ipv6Fixture([]byte("data"))
	truncated = truncated[:41]
	for _, b := range [][]byte{wrongVersion, oversized, truncated, {0x60}} {
		if _, err := newFramedIPv6Reader(bytes.NewReader(b)).Read(make([]byte, 1280)); err == nil {
			t.Fatal("accepted corrupt packet")
		}
	}
}
