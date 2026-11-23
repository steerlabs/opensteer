package media

import (
	"bytes"
	"encoding/binary"
	"slices"
	"testing"
	"time"
)

func testRTP(seq uint16, ts, ssrc uint32, pt uint8, marker bool, payload []byte) []byte {
	header := []byte{0x80, pt}
	if marker {
		header[1] |= 128
	}
	header = binary.BigEndian.AppendUint16(header, seq)
	header = binary.BigEndian.AppendUint32(header, ts)
	header = binary.BigEndian.AppendUint32(header, ssrc)
	return append(header, payload...)
}

func aggregation(header []byte, nals ...[]byte) []byte {
	out := bytes.Clone(header)
	for _, nal := range nals {
		out = binary.BigEndian.AppendUint16(out, uint16(len(nal)))
		out = append(out, nal...)
	}
	return out
}

func testAnnex(nals ...[]byte) []byte {
	var out []byte
	for _, nal := range nals {
		out = append(out, startCode...)
		out = append(out, nal...)
	}
	return out
}

func TestRTPHeaderAndMux(t *testing.T) {
	p := testRTP(0xfffd, 4, 21, 101, true, nil)
	p[0] |= 0x31
	p = append(p, 1, 2, 3, 4, 0xbe, 0xde, 0, 1, 5, 6, 7, 8, 0x65, 9, 0, 2)
	packet, ok := parseRTP(p)
	if !ok || packet.seq != 0xfffd || packet.timestamp != 4 || packet.ssrc != 21 ||
		packet.payloadType != 101 || !packet.marker || !bytes.Equal(packet.payload, []byte{0x65, 9}) {
		t.Fatalf("bad RTP header: %+v", packet)
	}
	rr := receiverReport(7, nil)
	if _, ok := parseRTP(rr); ok || !isRTCP(rr) || isRTCP(p) {
		t.Fatal("mixed up multiplexed RTP and RTCP")
	}
	p[19] = 0xff
	if _, ok := parseRTP(p); ok {
		t.Fatal("accepted truncated RTP extension")
	}
}

func TestDepacketizeAVCAndHEVC(t *testing.T) {
	for _, tc := range []struct {
		name                                               string
		hevc                                               bool
		params                                             [][]byte
		ap, singleKey, delta, fuStart, fuMid, fuEnd, fuKey []byte
	}{
		{"AVC", false, [][]byte{{0x67, 0x64, 0x00, 0x2a}, {0x68, 0x0f}}, []byte{0x78},
			[]byte{0x65, 0x11}, []byte{0x41, 0x16}, []byte{0x7c, 0x85, 0x21},
			[]byte{0x7c, 0x05, 0x22}, []byte{0x7c, 0x45, 0x23}, []byte{0x65, 0x21, 0x22, 0x23}},
		{"HEVC", true, [][]byte{{0x40, 1, 3}, {0x42, 1, 4}, {0x44, 1, 5}}, []byte{0x60, 1},
			[]byte{0x26, 1, 0x11}, []byte{0x02, 1, 0x16}, []byte{0x62, 1, 0x93, 0x21},
			[]byte{0x62, 1, 0x13, 0x22}, []byte{0x62, 1, 0x53, 0x23}, []byte{0x26, 1, 0x21, 0x22, 0x23}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := rtpReceiver{hevc: tc.hevc}
			now := time.Now()
			var units []accessUnit
			emit := func(unit accessUnit) {
				unit.annexB = bytes.Clone(unit.annexB)
				units = append(units, unit)
			}
			push := func(seq uint16, ts uint32, last bool, b []byte) (bool, bool) {
				return r.push(rtpPacket{seq: seq, timestamp: ts, marker: last, payload: b}, now, emit)
			}
			push(65530, 0, true, tc.delta)
			push(65531, 1, true, aggregation(tc.ap, tc.params...))
			push(65532, 2, true, tc.singleKey)
			push(65533, 3, false, tc.fuStart)
			push(65535, 3, true, tc.fuEnd)
			if accepted, _ := push(65535, 3, true, tc.fuEnd); accepted {
				t.Fatal("duplicate packet accepted")
			}
			push(65534, 3, false, tc.fuMid)
			push(0, 4, true, tc.delta)
			if len(units) != 3 ||
				units[0].timestamp != 2 || !units[0].key || !bytes.Equal(units[0].annexB, testAnnex(append(slices.Clone(tc.params), tc.singleKey)...)) ||
				units[1].timestamp != 3 || !units[1].key || !bytes.Equal(units[1].annexB, testAnnex(append(slices.Clone(tc.params), tc.fuKey)...)) ||
				units[2].timestamp != 4 || units[2].key || !bytes.Equal(units[2].annexB, testAnnex(tc.delta)) {
				t.Fatalf("unexpected access units: %+v", units)
			}
			push(1, 5, false, tc.fuStart)
			push(3, 5, true, tc.fuEnd)
			if r.expire(now.Add(reorderDelay/2), emit) || !r.expire(now.Add(reorderDelay), emit) {
				t.Fatal("packet loss did not honor the reorder timeout")
			}
			push(4, 6, true, tc.delta)
			if len(units) != 3 {
				t.Fatal("delivered a delta after packet loss")
			}
			push(5, 7, true, tc.singleKey)
			if len(units) != 4 || !units[3].key {
				t.Fatal("failed to recover at the next random access point")
			}
			r.reset()
			push(6, 8, true, tc.singleKey)
			if len(units) != 4 {
				t.Fatal("reset retained pre-flush parameter sets")
			}
		})
	}
}
