package media

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"regexp"
)

const (
	maxFramePayload = 4 * 1024 * 1024
	maxFrameHeader  = 16 * 1024
	maxEnvelope     = 4 + maxFrameHeader + maxFramePayload
	maxSafeInteger  = 1<<53 - 1
)

var (
	displayStreamID = regexp.MustCompile(`(?i)^dsp_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
	displayCodec    = regexp.MustCompile(`^avc1\.[0-9a-fA-F]{6}$`)
)

type mediaFrameHeader struct {
	StreamID   string `json:"streamId"`
	Generation uint64 `json:"generation"`
	Sequence   uint64 `json:"sequence"`
	PTSUs      uint64 `json:"ptsUs"`
	Key        bool   `json:"key"`
	Codec      string `json:"codec,omitempty"`
	Width      int    `json:"width"`
	Height     int    `json:"height"`
}

func encodeDisplayMediaFrame(header mediaFrameHeader, payload []byte) ([]byte, error) {
	if !displayStreamID.MatchString(header.StreamID) ||
		header.Generation == 0 || header.Generation > maxSafeInteger ||
		header.Sequence > maxSafeInteger || header.PTSUs > maxSafeInteger ||
		header.Width <= 0 || uint64(header.Width) > maxSafeInteger || header.Height <= 0 || uint64(header.Height) > maxSafeInteger ||
		(header.Key && !displayCodec.MatchString(header.Codec)) || (!header.Key && header.Codec != "") {
		return nil, errors.New("invalid display media header")
	}
	if len(payload) == 0 || len(payload) > maxFramePayload {
		return nil, errors.New("invalid display media payload size")
	}
	meta, err := json.Marshal(header)
	if err != nil {
		return nil, err
	}
	if len(meta) > maxFrameHeader {
		return nil, errors.New("invalid display media header size")
	}
	envelope := make([]byte, 4+len(meta)+len(payload))
	binary.BigEndian.PutUint32(envelope, uint32(len(meta)))
	copy(envelope[4:], meta)
	copy(envelope[4+len(meta):], payload)
	return envelope, nil
}
