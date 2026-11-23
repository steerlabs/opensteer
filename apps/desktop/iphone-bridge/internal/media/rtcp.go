package media

import (
	"encoding/binary"
	"time"
)

const (
	reportInterval   = 5 * time.Second
	keyframeInterval = 500 * time.Millisecond
)

type receptionReport struct {
	ssrc, extendedSeq, jitter, lastSR, delay uint32
	fraction                                 byte
	lost                                     int32
}

func rtcpPacket(kind, count byte, size int, ssrc uint32) []byte {
	packet := make([]byte, size)
	packet[0], packet[1] = 0x80|count, kind
	binary.BigEndian.PutUint16(packet[2:], uint16(size/4-1))
	binary.BigEndian.PutUint32(packet[4:], ssrc)
	return packet
}

func receiverReport(sender uint32, report *receptionReport) []byte {
	if report == nil {
		return rtcpPacket(201, 0, 8, sender)
	}
	packet := rtcpPacket(201, 1, 32, sender)
	binary.BigEndian.PutUint32(packet[8:], report.ssrc)
	binary.BigEndian.PutUint32(packet[12:], uint32(report.lost)&0xffffff|uint32(report.fraction)<<24)
	binary.BigEndian.PutUint32(packet[16:], report.extendedSeq)
	binary.BigEndian.PutUint32(packet[20:], report.jitter)
	binary.BigEndian.PutUint32(packet[24:], report.lastSR)
	binary.BigEndian.PutUint32(packet[28:], report.delay)
	return packet
}

func sourceDescription(sender uint32, cname string) []byte {
	cname = cname[:min(len(cname), 255)]
	packet := rtcpPacket(202, 1, (11+len(cname)+3)&^3, sender)
	packet[8], packet[9] = 1, byte(len(cname))
	copy(packet[10:], cname)
	return packet
}

func pictureLossIndication(sender, source uint32) []byte {
	packet := rtcpPacket(206, 1, 12, sender)
	binary.BigEndian.PutUint32(packet[8:], source)
	return packet
}

func fullIntraRequest(sender, source uint32, sequence byte) []byte {
	packet := rtcpPacket(206, 4, 20, sender)
	binary.BigEndian.PutUint32(packet[12:], source)
	packet[16] = sequence
	return packet
}

type rtcpController struct {
	source, sender, rate     uint32
	cname                    string
	nextReport, nextFeedback time.Time
	needKey                  bool
	requests                 uint
	fir                      byte

	received, expectedPrior, receivedPrior uint32
	base, highest                          uint32
	previousArrival                        time.Time
	previousTimestamp                      uint32
	jitter                                 float64
	lastSR                                 uint32
	lastSRAt                               time.Time
}

func (c *rtcpController) record(packet rtpPacket, now time.Time) {
	if c.received == 0 {
		c.base = uint32(packet.seq)
		c.highest = c.base
	} else {
		if diff := int16(packet.seq - uint16(c.highest)); diff > 0 {
			c.highest += uint32(diff)
		}
		delta := float64(now.Sub(c.previousArrival))*float64(c.rate)/float64(time.Second) -
			float64(int32(packet.timestamp-c.previousTimestamp))
		if delta < 0 {
			delta = -delta
		}
		c.jitter += (delta - c.jitter) / 16
	}
	c.previousTimestamp, c.previousArrival = packet.timestamp, now
	c.received++
}

func (c *rtcpController) receive(packet []byte, now time.Time) {
	for len(packet) >= 4 && packet[0]>>6 == 2 {
		size := 4 * (1 + int(binary.BigEndian.Uint16(packet[2:])))
		if size > len(packet) {
			return
		}
		if size >= 28 && packet[1] == 200 && binary.BigEndian.Uint32(packet[4:]) == c.source {
			c.lastSR = binary.BigEndian.Uint32(packet[10:14])
			c.lastSRAt = now
		}
		packet = packet[size:]
	}
}

func (c *rtcpController) report(now time.Time) *receptionReport {
	if c.received == 0 {
		return nil
	}
	expected := c.highest - c.base + 1
	lost := int64(expected) - int64(c.received)
	expectedInterval := expected - c.expectedPrior
	receivedInterval := c.received - c.receivedPrior
	c.expectedPrior, c.receivedPrior = expected, c.received
	var fraction byte
	if expectedInterval > receivedInterval {
		fraction = byte(min(255, uint64(expectedInterval-receivedInterval)*256/uint64(expectedInterval)))
	}
	var delay uint32
	if !c.lastSRAt.IsZero() {
		delay = uint32(now.Sub(c.lastSRAt).Seconds() * 65536)
	}
	return &receptionReport{
		ssrc: c.source, extendedSeq: c.highest,
		jitter: uint32(c.jitter), lastSR: c.lastSR, delay: delay,
		fraction: fraction, lost: int32(max(-0x800000, min(0x7fffff, lost))),
	}
}

func (c *rtcpController) tick(now time.Time) []byte {
	feedback := c.needKey && !now.Before(c.nextFeedback)
	periodic := !now.Before(c.nextReport)
	if !feedback && !periodic {
		return nil
	}
	c.nextReport = now.Add(reportInterval)
	out := receiverReport(c.sender, c.report(now))
	out = append(out, sourceDescription(c.sender, c.cname)...)
	if feedback {
		c.nextFeedback = now.Add(keyframeInterval)
		if c.requests == 0 {
			out = append(out, pictureLossIndication(c.sender, c.source)...)
		} else {
			c.fir++
			out = append(out, fullIntraRequest(c.sender, c.source, c.fir)...)
		}
		c.requests++
	}
	return out
}

func (c *rtcpController) gotKeyframe() {
	c.needKey, c.requests = false, 0
}
