package media

import (
	"bytes"
	"compress/zlib"
	"io"
	"testing"

	"github.com/google/uuid"
	"howett.net/plist"
)

func TestVideoNegotiation(t *testing.T) {
	id := uuid.MustParse("12345678-abcd-4321-9876-123456789012")
	encoded, err := BuildCleanVideoOffer(id, 42, OfferOptions{DisplayID: 2, Width: 800, Height: 1200, MaxFPS: 30, PreferAVC: true})
	if err != nil {
		t.Fatal(err)
	}
	var offer map[string]interface{}
	if _, err := plist.Unmarshal(encoded, &offer); err != nil {
		t.Fatal(err)
	}
	if offer["avcMediaStreamOptionCallID"] != "12345678-ABCD-4321-9876-123456789012" ||
		offer["avcMediaStreamNegotiatorMode"] != uint64(5) {
		t.Fatal("wrong offer mode or call ID")
	}
	z, err := zlib.NewReader(bytes.NewReader(offer[mediaBlobKey].([]byte)))
	if err != nil {
		t.Fatal(err)
	}
	blob, err := io.ReadAll(z)
	_ = z.Close()
	if err != nil {
		t.Fatal(err)
	}
	fields, ok := parseProto(blob)
	if !ok || len(fields.messages[5]) != 1 {
		t.Fatal("missing video settings")
	}
	video, ok := parseProto(fields.messages[5][0])
	if !ok || video.scalars[1] != 42 || len(video.messages[3]) != 2 {
		t.Fatal("wrong video settings")
	}
	preferred, ok := parseProto(video.messages[3][0])
	if !ok || preferred.scalars[4] != 1 {
		t.Fatal("AVC was not preferred")
	}

	// An independently generated synthetic device answer selects one codec.
	var group protoMessage
	group.number(1, 3)
	payload := numbers(1, 111)
	payload.number(7, 24000)
	group.data(2, payload)
	stream := numbers(0, 111, 0, 47)
	group.data(3, stream)
	group.data(4, numbers(42))
	var answerMsg protoMessage
	answerMsg.data(7, group)

	for _, compressed := range []bool{false, true} {
		blob := []byte(answerMsg)
		if compressed {
			var buffer bytes.Buffer
			writer := zlib.NewWriter(&buffer)
			if _, err := writer.Write(blob); err != nil {
				t.Fatal(err)
			}
			if err := writer.Close(); err != nil {
				t.Fatal(err)
			}
			blob = buffer.Bytes()
		}
		answerBytes, err := plist.Marshal(map[string]interface{}{mediaBlobKey: blob}, plist.BinaryFormat)
		if err != nil {
			t.Fatal(err)
		}
		output := map[string]interface{}{
			"senderPort": uint64(12345),
			"streamConfig": map[string]interface{}{
				"SyncStreamToken": map[string]interface{}{"uuid": id},
				"CustomWidth":     float64(800), "CustomHeight": int64(1200),
			},
			"negotiatorAnswer": answerBytes,
		}
		want := StreamAnswer{id.String(), 12345, 47, 42, 111, "avc", 24000, 800, 1200}
		if got, err := ParseVideoAnswer(output); err != nil || got != want {
			t.Fatalf("got %+v, %v, want %+v", got, err, want)
		}
	}
}

func TestLegacyVideoAnswerAndMalformedAnswer(t *testing.T) {
	video := numbers(999)
	video.data(3, numbers(110, 0, 0, 14))
	var blob protoMessage
	blob.data(5, video)
	for _, tc := range []struct {
		name  string
		value []byte
		ok    bool
	}{
		{"legacy", blob, true},
		{"truncated varint", append(bytes.Clone(blob), 0x80), false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			answer, err := plist.Marshal(map[string]interface{}{mediaBlobKey: tc.value}, plist.BinaryFormat)
			if err != nil {
				t.Fatal(err)
			}
			got, err := ParseVideoAnswer(map[string]interface{}{"negotiatorAnswer": answer})
			if tc.ok && (err != nil || got.LocalSSRC != 999 || got.PayloadType != 110 || got.Codec != "hevc" || got.ClockRate != 90000) {
				t.Fatalf("unexpected answer: %+v, %v", got, err)
			}
			if !tc.ok && err == nil {
				t.Fatal("accepted malformed negotiation")
			}
		})
	}
}
