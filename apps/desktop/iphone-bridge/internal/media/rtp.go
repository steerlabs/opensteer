package media

import (
	"bytes"
	"encoding/binary"
	"time"
)

const (
	reorderWindow  = 128
	maxNALsPerUnit = 512
	reorderDelay   = 40 * time.Millisecond
)

var startCode = []byte{0, 0, 0, 1}

type rtpPacket struct {
	seq             uint16
	timestamp, ssrc uint32
	payloadType     uint8
	marker          bool
	payload         []byte
}

func isRTCP(packet []byte) bool {
	return len(packet) >= 4 && packet[0]>>6 == 2 && packet[1] >= 192 && packet[1] <= 223
}

func parseRTP(packet []byte) (rtpPacket, bool) {
	if len(packet) < 12 || packet[0]>>6 != 2 || isRTCP(packet) {
		return rtpPacket{}, false
	}
	start := 12 + 4*int(packet[0]&15)
	end := len(packet)
	if packet[0]&0x10 != 0 {
		if start+4 > end {
			return rtpPacket{}, false
		}
		start += 4 + 4*int(binary.BigEndian.Uint16(packet[start+2:]))
	}
	if packet[0]&0x20 != 0 {
		padding := int(packet[end-1])
		if padding == 0 {
			return rtpPacket{}, false
		}
		end -= padding
	}
	if start >= end {
		return rtpPacket{}, false
	}
	return rtpPacket{
		seq:         binary.BigEndian.Uint16(packet[2:]),
		timestamp:   binary.BigEndian.Uint32(packet[4:]),
		ssrc:        binary.BigEndian.Uint32(packet[8:]),
		payloadType: packet[1] & 127,
		marker:      packet[1]&128 != 0,
		payload:     packet[start:end],
	}, true
}

type accessUnit struct {
	annexB    []byte
	timestamp uint32
	key       bool
}

type rtpReceiver struct {
	hevc         bool
	initialized  bool
	next         uint16
	waitingSince time.Time
	reorder      map[uint16]rtpPacket

	timestamp               uint32
	active, damaged, synced bool
	au                      []byte
	nalCount                int
	fragmentType            byte
	fragment                bool
	params                  [3][]byte
}

func (r *rtpReceiver) push(packet rtpPacket, now time.Time, emit func(accessUnit)) (accepted, lost bool) {
	if !r.initialized {
		r.next = packet.seq
		r.initialized = true
		r.reorder = make(map[uint16]rtpPacket)
	}
	distance := int16(packet.seq - r.next)
	if distance < 0 {
		return false, false
	}
	if distance >= reorderWindow {
		r.clearReorder()
		r.next = packet.seq
		r.loseThrough(packet.timestamp)
		lost = true
	}
	if packet.seq == r.next {
		r.next++
		lost = r.consume(packet, emit) || lost
		return true, r.drain(now, emit) || lost
	}
	if _, exists := r.reorder[packet.seq]; exists {
		return false, false
	}
	packet.payload = bytes.Clone(packet.payload)
	r.reorder[packet.seq] = packet
	if r.waitingSince.IsZero() {
		r.waitingSince = now
	}
	return true, r.expire(now, emit) || lost
}

func (r *rtpReceiver) expire(now time.Time, emit func(accessUnit)) bool {
	if r.waitingSince.IsZero() || now.Sub(r.waitingSince) < reorderDelay {
		return false
	}
	var first rtpPacket
	distance := uint16(reorderWindow)
	for seq, p := range r.reorder {
		if seq-r.next < distance {
			distance, first = seq-r.next, p
		}
	}
	r.loseThrough(first.timestamp)
	r.next = first.seq
	r.waitingSince = now
	r.drain(now, emit)
	return true
}

func (r *rtpReceiver) drain(now time.Time, emit func(accessUnit)) (lost bool) {
	for {
		packet, ok := r.reorder[r.next]
		if !ok {
			break
		}
		delete(r.reorder, r.next)
		r.next++
		lost = r.consume(packet, emit) || lost
		clear(packet.payload)
	}
	if len(r.reorder) == 0 {
		r.waitingSince = time.Time{}
	} else if r.waitingSince.IsZero() {
		r.waitingSince = now
	}
	return lost
}

func (r *rtpReceiver) clearReorder() {
	for _, packet := range r.reorder {
		clear(packet.payload)
	}
	clear(r.reorder)
	r.waitingSince = time.Time{}
}

func (r *rtpReceiver) loseThrough(timestamp uint32) {
	r.discardAU()
	r.timestamp, r.active, r.damaged, r.synced = timestamp, true, true, false
}

func (r *rtpReceiver) discardAU() {
	clear(r.au)
	r.au = r.au[:0]
	r.nalCount = 0
	r.fragment = false
}

func (r *rtpReceiver) reset() {
	r.discardAU()
	r.clearReorder()
	for _, param := range r.params {
		clear(param)
	}
	*r = rtpReceiver{hevc: r.hevc}
}

func (r *rtpReceiver) consume(packet rtpPacket, emit func(accessUnit)) (lost bool) {
	if r.active && packet.timestamp != r.timestamp {
		lost = !r.damaged && (len(r.au) != 0 || r.fragment)
		if lost {
			r.synced = false
		}
		r.discardAU()
		r.active, r.damaged = false, false
	}
	if !r.active {
		r.timestamp, r.active = packet.timestamp, true
	}
	if !r.damaged && !r.appendPayload(packet.payload) {
		r.loseThrough(packet.timestamp)
		lost = true
	}
	if !packet.marker {
		return lost
	}
	if r.fragment {
		r.loseThrough(packet.timestamp)
		lost = true
	} else if !r.damaged {
		if au, ready := r.finish(); ready {
			emit(au)
			clear(au.annexB)
		}
	}
	r.discardAU()
	r.active, r.damaged = false, false
	return lost
}

func (r *rtpReceiver) kind(nal []byte) byte {
	if r.hevc {
		return nal[0] >> 1 & 63
	}
	return nal[0] & 31
}

func (r *rtpReceiver) validNAL(nal []byte) bool {
	if len(nal) == 0 || nal[0]&128 != 0 {
		return false
	}
	kind := r.kind(nal)
	if r.hevc {
		return len(nal) >= 2 && nal[1]&7 != 0 && kind < 48
	}
	return kind >= 1 && kind <= 23
}

func (r *rtpReceiver) addNAL(nal []byte) bool {
	if r.nalCount == maxNALsPerUnit || !r.validNAL(nal) || len(r.au)+len(startCode)+len(nal) > maxFramePayload {
		return false
	}
	r.au = append(r.au, startCode...)
	r.au = append(r.au, nal...)
	r.nalCount++
	return true
}

func (r *rtpReceiver) appendPayload(payload []byte) bool {
	if len(payload) == 0 || payload[0]&128 != 0 || (r.hevc && (len(payload) < 2 || payload[1]&7 == 0)) {
		return false
	}
	kind := r.kind(payload)
	headerSize, aggregation, fragmentation := 1, byte(24), byte(28)
	if r.hevc {
		headerSize, aggregation, fragmentation = 2, 48, 49
	}
	switch kind {
	case fragmentation:
		return r.appendFragment(payload, headerSize)
	case aggregation:
		if r.fragment {
			return false
		}
		count := 0
		for remaining := payload[headerSize:]; len(remaining) != 0; count++ {
			if len(remaining) < 2 {
				return false
			}
			size := int(binary.BigEndian.Uint16(remaining))
			remaining = remaining[2:]
			if size > len(remaining) || !r.addNAL(remaining[:size]) {
				return false
			}
			remaining = remaining[size:]
		}
		return count >= headerSize
	default:
		return !r.fragment && r.addNAL(payload)
	}
}

// HEVC is negotiated without decoding-order-number fields.
func (r *rtpReceiver) appendFragment(payload []byte, headerSize int) bool {
	if len(payload) < headerSize+1 || (r.hevc && len(payload) == headerSize+1) {
		return false
	}
	flags := payload[headerSize]
	start, end := flags&128 != 0, flags&64 != 0
	var header [2]byte
	kind := flags & 31
	header[0] = payload[0]&0xe0 | kind
	if r.hevc {
		kind = flags & 63
		header = [2]byte{payload[0]&0x81 | kind<<1, payload[1]}
	}
	if (start && end) || !r.validNAL(header[:headerSize]) || (!r.hevc && flags&32 != 0) {
		return false
	}
	body := payload[headerSize+1:]
	extra := 0
	if start {
		extra = len(startCode) + headerSize
	}
	if len(r.au)+extra+len(body) > maxFramePayload {
		return false
	}
	if start {
		if r.fragment || !r.addNAL(header[:headerSize]) {
			return false
		}
		r.fragment, r.fragmentType = true, kind
	} else if !r.fragment || r.fragmentType != kind {
		return false
	}
	r.au = append(r.au, body...)
	r.fragment = !end
	return true
}

func annexNALs(annex []byte) [][]byte {
	var nals [][]byte
	for {
		start := bytes.Index(annex, startCode[1:])
		if start < 0 {
			break
		}
		annex = annex[start+3:]
		end := bytes.Index(annex, startCode[1:])
		if end < 0 {
			end = len(annex)
		}
		if nal := bytes.TrimRight(annex[:end], "\x00"); len(nal) != 0 {
			nals = append(nals, nal)
		}
		annex = annex[end:]
	}
	return nals
}

func (r *rtpReceiver) finish() (accessUnit, bool) {
	vcl, key := false, false
	var pictures []byte
	for _, nal := range annexNALs(r.au) {
		kind := r.kind(nal)
		i := -1
		if r.hevc {
			vcl = vcl || kind <= 31
			key = key || (kind >= 16 && kind <= 21)
			if kind >= 32 && kind <= 34 {
				i = int(kind - 32)
			}
		} else {
			vcl = vcl || (kind >= 1 && kind <= 5)
			key = key || kind == 5
			if kind == 7 || kind == 8 {
				i = int(kind - 7)
			}
		}
		if i >= 0 {
			// Parameter sets are bounded independently of the access unit.
			if len(nal) <= 65535 && !bytes.Equal(r.params[i], nal) {
				clear(r.params[i])
				r.params[i] = bytes.Clone(nal)
				r.synced = false
			}
			continue
		}
		pictures = append(pictures, startCode...)
		pictures = append(pictures, nal...)
	}
	defer clear(pictures)
	if !vcl || (!key && !r.synced) {
		return accessUnit{}, false
	}
	var annex []byte
	if key {
		count := 2
		if r.hevc {
			count = 3
		}
		for _, param := range r.params[:count] {
			if len(param) == 0 {
				clear(annex)
				return accessUnit{}, false
			}
			annex = append(annex, startCode...)
			annex = append(annex, param...)
		}
	}
	if len(annex)+len(pictures) > maxFramePayload {
		clear(annex)
		r.synced = false
		return accessUnit{}, false
	}
	r.synced = true
	result := make([]byte, len(annex)+len(pictures))
	copy(result, annex)
	copy(result[len(annex):], pictures)
	clear(annex)
	return accessUnit{result, r.timestamp, key}, true
}
