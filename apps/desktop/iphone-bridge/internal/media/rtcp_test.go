package media

import (
	"bytes"
	"encoding/hex"
	"testing"
	"time"
)

func TestRTCPPackets(t *testing.T) {
	const sender = 0x11223344
	const source = 0x55667788
	for _, tc := range []struct {
		got  []byte
		want string
	}{
		{receiverReport(sender, nil), "80c9000111223344"},
		{receiverReport(sender, &receptionReport{
			ssrc: source, fraction: 0x20, lost: -2, extendedSeq: 0x10001, jitter: 8, lastSR: 9, delay: 10,
		}), "81c90007112233445566778820fffffe0001000100000008000000090000000a"},
		{sourceDescription(sender, "test"), "81ca0003112233440104746573740000"},
		{pictureLossIndication(sender, source), "81ce00021122334455667788"},
		{fullIntraRequest(sender, source, 17), "84ce000411223344000000005566778811000000"},
	} {
		if got := hex.EncodeToString(tc.got); got != tc.want {
			t.Errorf("got %s, want %s", got, tc.want)
		}
	}
}

func TestRTCPFeedbackAndCadence(t *testing.T) {
	now := time.Now()
	r := rtpReceiver{}
	feedback := rtcpController{sender: 8, source: 9, rate: 90000, cname: "test"}
	emit := func(accessUnit) {}
	r.push(rtpPacket{seq: 7, timestamp: 100, payload: []byte{0x67, 1}}, now, emit)
	r.push(rtpPacket{seq: 9, timestamp: 100, marker: true, payload: []byte{0x68, 1}}, now, emit)
	feedback.needKey = r.expire(now.Add(reorderDelay), emit)
	if packet := feedback.tick(now); !bytes.HasSuffix(packet, pictureLossIndication(8, 9)) {
		t.Fatal("loss should trigger PLI after RR and SDES")
	}
	if packet := feedback.tick(now.Add(keyframeInterval - 1)); packet != nil {
		t.Fatal("feedback exceeded rate limit")
	}
	if packet := feedback.tick(now.Add(keyframeInterval)); !bytes.HasSuffix(packet, fullIntraRequest(8, 9, 1)) {
		t.Fatal("missing FIR fallback")
	}
	feedback.gotKeyframe()
	if packet := feedback.tick(now.Add(2 * keyframeInterval)); packet != nil {
		t.Fatal("requested another keyframe after recovery")
	}
	want := append(receiverReport(8, nil), sourceDescription(8, "test")...)
	if packet := feedback.tick(now.Add(keyframeInterval + reportInterval)); !bytes.Equal(packet, want) {
		t.Fatal("missing periodic report")
	}
}
