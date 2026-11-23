package media

import (
	"bytes"
	"compress/zlib"
	"errors"
	"io"
	"math"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"google.golang.org/protobuf/encoding/protowire"
	"howett.net/plist"
)

type OfferOptions struct {
	DisplayID uint64
	Width     int
	Height    int
	MaxFPS    int
	PreferAVC bool
}

type StreamAnswer struct {
	StreamToken string
	RemotePort  uint16
	LocalSSRC   uint32 // Device's RTP sender SSRC
	RemoteSSRC  uint32 // Host's RTCP sender SSRC
	PayloadType uint8
	Codec       string
	ClockRate   uint32
	Width       int
	Height      int
}

const (
	mediaBlobKey       = "avcMediaStreamNegotiatorMediaBlob"
	maxNegotiationSize = 1 << 20
)

type protoMessage []byte

func (m *protoMessage) number(field protowire.Number, value uint64) {
	*m = protowire.AppendVarint(protowire.AppendTag(*m, field, protowire.VarintType), value)
}

func (m *protoMessage) data(field protowire.Number, value []byte) {
	*m = protowire.AppendBytes(protowire.AppendTag(*m, field, protowire.BytesType), value)
}

func numbers(values ...uint64) protoMessage {
	var m protoMessage
	for i, value := range values {
		m.number(protowire.Number(i+1), value)
	}
	return m
}

const (
	screenHEVCFeatureList = "FLS;MS:-1;LF:-1;LTR;CABAC;POS:0;EOD:1;HTS:2;RR:3;AR:16/9,5/8;XR:16/9,5/8;"
	screenAVCFeatureList  = "FLS;SW:1;"
)

func buildOfferTail(blob *protoMessage) {
	blob.data(6, []byte("Viceroy 1.7.0"))
	blob.number(8, 0)
	for _, tier := range [][]uint64{
		{0, 20_000_000, 0x18000}, {4074, 0, 0x4000}, {0, 60_000_000, 0x40000},
		{0, 40_000_000, 0x3000}, {16, 4100}, {0, 6_000_000, 0x20000},
		{4, 6500}, {0, 100_000_000, 0x100000}, {1, 299}, {0, 75_000_000, 0x80000},
	} {
		blob.data(9, numbers(tier...))
	}
	now := time.Now()
	ntpTime := uint64(now.Unix()+2_208_988_800)<<32 | (uint64(now.Nanosecond())<<32)/1_000_000_000
	blob.number(13, ntpTime)
	blob.number(14, 2)
	blob.number(16, 0)
	blob.number(18, 1)
}

func marshalOfferPlist(callID uuid.UUID, mode int, blob []byte) ([]byte, error) {
	var compressed bytes.Buffer
	writer, err := zlib.NewWriterLevel(&compressed, zlib.DefaultCompression)
	if err != nil {
		return nil, err
	}
	_, err = writer.Write(blob)
	closeErr := writer.Close()
	if err = errors.Join(err, closeErr); err != nil {
		return nil, err
	}

	endpoint := numbers(0, 1)
	endpoint.data(3, []byte("Mac17,7"))
	endpoint.data(4, []byte("2205.3.1"))
	endpoint.data(5, []byte("25F71"))
	return plist.Marshal(map[string]interface{}{
		"avcMediaStreamOptionCallID":             strings.ToUpper(callID.String()),
		"avcMediaStreamNegotiatorMode":           mode,
		"avcMediaStreamOptionRemoteEndpointInfo": []byte(endpoint),
		mediaBlobKey:                             compressed.Bytes(),
	}, plist.BinaryFormat)
}

// BuildCleanAudioOffer writes the CoreDevice system-audio offer (mode 6) used to
// initialize the screen-sharing session before starting the video stream.
func BuildCleanAudioOffer(callID uuid.UUID, sessionID uint32) ([]byte, error) {
	if callID == uuid.Nil || sessionID == 0 {
		return nil, errors.New("invalid audio offer options")
	}
	audio := numbers(uint64(sessionID), 0, 0, 24191, 0, 0)
	blob := numbers(1, 1)
	blob.data(3, audio)
	buildOfferTail(&blob)
	return marshalOfferPlist(callID, 6, blob)
}

// BuildCleanVideoOffer writes the CoreDevice screen offer using protobuf and a
// binary plist. Display selection is passed in the CoreDevice request. The
// output size and frame rate are enforced by the local encoder.
func BuildCleanVideoOffer(callID uuid.UUID, sessionID uint32, opts OfferOptions) ([]byte, error) {
	if callID == uuid.Nil || sessionID == 0 || opts.Width < 0 || opts.Height < 0 || opts.MaxFPS < 0 {
		return nil, errors.New("invalid video offer options")
	}
	settings := numbers(uint64(sessionID), 0)
	formats := []struct {
		payload, mode uint64
		features      string
		descriptors   int
	}{
		{123, 1, screenAVCFeatureList, 4},
		{100, 14, screenHEVCFeatureList, 2},
	}
	if !opts.PreferAVC {
		formats[0], formats[1] = formats[1], formats[0]
	}
	for _, format := range formats {
		capability := numbers(format.payload)
		for i := range format.descriptors {
			capability.data(2, numbers(1, uint64(1+i%2), 0xc3c3, 0))
		}
		capability.data(3, []byte(format.features))
		capability.number(4, format.mode)
		settings.data(3, capability)
	}
	settings.number(7, 1)
	settings.number(8, 63)
	settings.number(12, 1)

	blob := numbers(1, 1)
	blob.data(5, settings)
	buildOfferTail(&blob)
	return marshalOfferPlist(callID, 5, blob)
}

func answerValue(output map[string]interface{}, keys ...string) interface{} {
	for _, key := range keys {
		if value, ok := output[key]; ok {
			if wrapper, ok := value.(map[string]interface{}); ok {
				for _, kind := range []string{"int", "string", "uuid", "uint"} {
					if wrapped, ok := wrapper[kind]; ok {
						return wrapped
					}
				}
			}
			return value
		}
	}
	return nil
}

func answerNumber(value interface{}, limit uint64) uint64 {
	var n uint64
	switch v := value.(type) {
	case uint64:
		n = v
	case uint32:
		n = uint64(v)
	case uint16:
		n = uint64(v)
	case uint8:
		n = uint64(v)
	case int64:
		n = uint64(v)
	case int:
		n = uint64(v)
	case float64:
		if v >= 0 && v <= float64(limit) && math.Trunc(v) == v {
			n = uint64(v)
		}
	}
	if n > limit {
		return 0
	}
	return n
}

func normalizeCodec(value interface{}) string {
	if name, ok := value.(string); ok {
		switch strings.ToLower(name) {
		case "avc", "h264", "h.264", "avc1":
			return "avc"
		case "hevc", "h265", "h.265", "hvc1":
			return "hevc"
		}
	}
	return ""
}

// ParseVideoAnswer extracts device-side stream parameters from the CoreDevice
// output dictionary and its optional AVConference answer. Geometry may be
// absent until the first in-band parameter sets arrive.
func ParseVideoAnswer(output map[string]interface{}) (StreamAnswer, error) {
	config, _ := output["streamConfig"].(map[string]interface{})
	options, _ := output["options"].(map[string]interface{})
	server, _ := output["serverInfo"].(map[string]interface{})
	device, _ := server["device"].(map[string]interface{})
	deviceConfig, _ := device["streamConfig"].(map[string]interface{})
	configOptions, _ := config["options"].(map[string]interface{})
	get := func(keys ...string) interface{} {
		for _, fields := range []map[string]interface{}{output, config, configOptions, options, device, deviceConfig, server} {
			if v := answerValue(fields, keys...); v != nil {
				return v
			}
		}
		return nil
	}
	n := func(limit uint64, keys ...string) uint64 {
		return answerNumber(get(keys...), limit)
	}
	answer := StreamAnswer{
		RemotePort:  uint16(n(math.MaxUint16, "senderPort", "RemotePort", "remotePort", "SourcePort", "RTCPRemotePort")),
		LocalSSRC:   uint32(n(math.MaxUint32, "LocalSSRC", "localSSRC")),
		RemoteSSRC:  uint32(n(math.MaxUint32, "RemoteSSRC", "remoteSSRC")),
		PayloadType: uint8(n(127, "RxPayloadType", "TxPayloadType", "payloadType", "PayloadType")),
		Codec:       normalizeCodec(get("codec", "Codec")),
		ClockRate:   uint32(n(math.MaxUint32, "clockRate", "ClockRate")),
		Width:       int(n(maxPictureDimension, "width", "CustomWidth", "Width", "VideoStreamDisplayWidth")),
		Height:      int(n(maxPictureDimension, "height", "CustomHeight", "Height", "VideoStreamDisplayHeight")),
	}
	switch token := get("streamToken", "StreamToken", "SyncStreamToken", "VideoSynchronizationSourceStreamToken").(type) {
	case string:
		answer.StreamToken = token
	case uuid.UUID:
		answer.StreamToken = token.String()
	default:
		if n := answerNumber(token, maxSafeInteger); n != 0 {
			answer.StreamToken = strconv.FormatUint(n, 10)
		}
	}
	if raw, ok := get("negotiatorAnswer").([]byte); ok {
		if err := readAnswerBlob(raw, &answer); err != nil {
			return StreamAnswer{}, err
		}
	}
	// RFC 6184 and RFC 7798 specify a 90 kHz video clock when the answer
	// omits the rate. CoreDevice can explicitly negotiate a different rate.
	if answer.ClockRate == 0 {
		answer.ClockRate = 90000
	}
	if answer.Codec == "" {
		switch answer.PayloadType {
		case 123:
			answer.Codec = "avc"
		case 100:
			answer.Codec = "hevc"
		}
	}
	if answer.LocalSSRC == 0 || answer.PayloadType < 96 || answer.Codec == "" {
		return StreamAnswer{}, errors.New("incomplete video stream answer")
	}
	return answer, nil
}

func readAnswerBlob(raw []byte, answer *StreamAnswer) error {
	invalid := errors.New("invalid video negotiation answer")
	var fields map[string]interface{}
	if len(raw) < 8 || len(raw) > maxNegotiationSize {
		return invalid
	}
	if _, err := plist.Unmarshal(raw, &fields); err != nil {
		return invalid
	}
	blob, ok := fields[mediaBlobKey].([]byte)
	if !ok {
		return invalid
	}
	if reader, err := zlib.NewReader(bytes.NewReader(blob)); err == nil {
		blob, err = io.ReadAll(io.LimitReader(reader, maxNegotiationSize+1))
		_ = reader.Close()
		if err != nil || len(blob) > maxNegotiationSize {
			return invalid
		}
	}
	root, ok := parseProto(blob)
	if !ok {
		return invalid
	}
	for _, data := range root.messages[7] {
		group, ok := parseProto(data)
		if !ok {
			return invalid
		}
		if group.scalars[1] != 3 {
			continue
		}
		return readScreenGroup(group, answer, invalid)
	}
	for _, data := range root.messages[5] {
		video, ok := parseProto(data)
		if !ok {
			return invalid
		}
		if err := readScreenSettings(video, answer, invalid); err != nil {
			return err
		}
	}
	return nil
}

func readScreenSettings(video protoFields, answer *StreamAnswer, invalid error) error {
	for _, data := range video.messages[3] {
		payload, ok := parseProto(data)
		if !ok {
			return invalid
		}
		pt := payload.scalars[1]
		codec := negotiatedCodec(payload.scalars[4])
		if pt < 96 || pt > 127 || codec == "" ||
			(answer.PayloadType != 0 && uint8(pt) != answer.PayloadType) ||
			(answer.Codec != "" && codec != answer.Codec) {
			continue
		}
		if payload.scalars[8] != 0 {
			return errors.New("encrypted video transport is unsupported")
		}
		if answer.PayloadType == 0 {
			answer.PayloadType, answer.Codec = uint8(pt), codec
		} else if answer.Codec == "" {
			answer.Codec = codec
		}
		if ssrc := video.scalars[1]; answer.LocalSSRC == 0 && ssrc <= math.MaxUint32 {
			answer.LocalSSRC = uint32(ssrc)
		}
	}
	return nil
}

func negotiatedCodec(value uint64) string {
	switch value {
	case 1:
		return "avc"
	case 14:
		return "hevc"
	}
	return ""
}

func readScreenGroup(group protoFields, answer *StreamAnswer, invalid error) error {
	var stream protoFields
	for _, data := range group.messages[3] {
		fields, ok := parseProto(data)
		if !ok {
			return invalid
		}
		if ssrc := fields.scalars[4]; ssrc > 0 && ssrc <= math.MaxUint32 {
			stream = fields
			if answer.LocalSSRC == 0 {
				answer.LocalSSRC = uint32(ssrc)
			}
			break
		}
	}
	for _, data := range group.messages[2] {
		payload, ok := parseProto(data)
		if !ok {
			return invalid
		}
		pt := payload.scalars[2]
		if pt < 96 || pt > 127 || (answer.PayloadType != 0 && pt != uint64(answer.PayloadType)) {
			continue
		}
		if selected := stream.scalars[2]; selected >= 96 && selected <= 127 && selected != pt {
			continue
		}
		if payload.scalars[8] != 0 {
			return errors.New("encrypted video transport is unsupported")
		}
		if answer.Codec == "" {
			answer.Codec = negotiatedCodec(payload.scalars[1])
			if answer.Codec == "" {
				switch pt {
				case 123:
					answer.Codec = "avc"
				case 100:
					answer.Codec = "hevc"
				}
			}
		}
		if answer.Codec != "" {
			answer.PayloadType = uint8(pt)
			if rate := payload.scalars[7]; answer.ClockRate == 0 && rate <= math.MaxUint32 {
				answer.ClockRate = uint32(rate)
			}
			break
		}
	}
	for _, data := range group.messages[4] {
		settings, ok := parseProto(data)
		if !ok {
			return invalid
		}
		if ssrc := settings.scalars[1]; answer.RemoteSSRC == 0 && ssrc <= math.MaxUint32 {
			answer.RemoteSSRC = uint32(ssrc)
		}
	}
	return nil
}

type protoFields struct {
	scalars  map[protowire.Number]uint64
	messages map[protowire.Number][][]byte
}

func parseProto(b []byte) (protoFields, bool) {
	f := protoFields{make(map[protowire.Number]uint64), make(map[protowire.Number][][]byte)}
	for len(b) > 0 {
		num, wire, size := protowire.ConsumeTag(b)
		if size < 0 {
			return protoFields{}, false
		}
		b = b[size:]
		size = 0
		switch wire {
		case protowire.VarintType:
			var value uint64
			value, size = protowire.ConsumeVarint(b)
			f.scalars[num] = value
		case protowire.BytesType:
			var value []byte
			value, size = protowire.ConsumeBytes(b)
			f.messages[num] = append(f.messages[num], value)
		case protowire.Fixed32Type, protowire.Fixed64Type:
			size = protowire.ConsumeFieldValue(num, wire, b)
		}
		if size <= 0 {
			return protoFields{}, false
		}
		b = b[size:]
	}
	return f, true
}
