package media

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"testing"
)

const testStreamID = "dsp_12345678-abcd-4321-9876-123456789012"

func TestDisplayEnvelope(t *testing.T) {
	payload := testAnnex([]byte{0x67, 0x64, 0, 0x2a}, []byte{0x68, 1}, []byte{0x65, 1})
	header := mediaFrameHeader{testStreamID, 1, 0, 0, true, "avc1.64002a", 888, 1920}
	encoded, err := encodeDisplayMediaFrame(header, payload)
	if err != nil {
		t.Fatal(err)
	}
	wantHeader := fmt.Sprintf(`{"streamId":%q,"generation":1,"sequence":0,"ptsUs":0,"key":true,"codec":"avc1.64002a","width":888,"height":1920}`, testStreamID)
	want := binary.BigEndian.AppendUint32(nil, uint32(len(wantHeader)))
	want = append(want, wantHeader...)
	want = append(want, payload...)
	if !bytes.Equal(encoded, want) || maxEnvelope != 4210692 {
		t.Fatal("wire bytes differ from the display envelope")
	}
	header.Key = false
	if _, err := encodeDisplayMediaFrame(header, payload); err == nil {
		t.Fatal("delta may not have a codec")
	}
	header.Codec = ""
	delta, err := encodeDisplayMediaFrame(header, testAnnex([]byte{0x41, 1}))
	if err != nil || bytes.Contains(delta, []byte("codec")) {
		t.Fatal("delta must omit codec")
	}
	header.Key = true
	if _, err := encodeDisplayMediaFrame(header, payload); err == nil {
		t.Fatal("keyframe must have codec")
	}
	header.Codec = "avc1.64002a"
	if _, err := encodeDisplayMediaFrame(header, make([]byte, maxFramePayload+1)); err == nil {
		t.Fatal("oversized payload accepted")
	}
}
