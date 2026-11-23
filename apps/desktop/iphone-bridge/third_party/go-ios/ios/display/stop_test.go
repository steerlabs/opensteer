package display

import (
	"bytes"
	"context"
	"errors"
	"io"
	"testing"

	"github.com/google/uuid"
)

type stopChannel struct {
	sendErr, receiveErr error
	sent                map[string]interface{}
	reply               map[string]interface{}
}

func (c *stopChannel) Send(m map[string]interface{}, _ ...uint32) error { c.sent = m; return c.sendErr }
func (c *stopChannel) ReceiveOnServerClientStream() (map[string]interface{}, error) {
	return c.reply, c.receiveErr
}
func (c *stopChannel) Close() error { return nil }
func TestStopAcceptsDropOnlyAfterRequestSent(t *testing.T) {
	for _, test := range []struct {
		send, receive error
		want          bool
	}{{nil, io.EOF, true}, {nil, io.ErrUnexpectedEOF, true}, {io.EOF, nil, false}, {nil, errors.New("invalid frame"), false}} {
		channel := &stopChannel{sendErr: test.send, receiveErr: test.receive}
		service := NewWithConnection(channel)
		id := uuid.New()
		err := service.StopMediaStreamScoped(context.Background(), id, false)
		if (err == nil) != test.want {
			t.Fatalf("send=%v receive=%v: %v", test.send, test.receive, err)
		}
		input := channel.sent["CoreDevice.input"].(map[string]interface{})
		option := input["avcMediaStreamOptionClientSessionID"].(map[string]interface{})
		if input["stopAll"] != false || option["uuid"] != id {
			t.Fatal("stop was not scoped to the client session")
		}
	}
	channel := &stopChannel{reply: map[string]interface{}{"CoreDevice.error": map[string]interface{}{"domain": "test", "code": int64(1)}}}
	if NewWithConnection(channel).StopMediaStream(context.Background(), uuid.New()) == nil {
		t.Fatal("explicit stop rejection became success")
	}
}

func TestLegacyDisplayStopFlag(t *testing.T) {
	channel := &stopChannel{receiveErr: io.EOF}
	service := NewWithConnection(channel)
	if err := service.StopMediaStream(context.Background(), uuid.New()); err != nil {
		t.Fatal(err)
	}
	input := channel.sent["CoreDevice.input"].(map[string]interface{})
	if input["stopAll"] != true {
		t.Fatal("legacy stop omitted stopAll=true")
	}
}

func TestStartVideoStreamReturnsFullOutput(t *testing.T) {
	output := map[string]interface{}{"senderPort": uint64(5555), "negotiatorAnswer": []byte{1, 2}}
	channel := &stopChannel{reply: map[string]interface{}{"CoreDevice.output": output}}
	service := NewWithConnection(channel)
	offer := []byte{7, 8, 9}
	id, got, err := service.StartVideoStreamWithOffer(context.Background(), VideoStreamRequest{
		ReceiverIP: "fd00::1", ReceiverPort: 54321, SenderIP: "fd00::2", DisplayID: 3,
	}, offer)
	if err != nil || id == uuid.Nil || got["senderPort"] != uint64(5555) ||
		!bytes.Equal(got["negotiatorAnswer"].([]byte), output["negotiatorAnswer"].([]byte)) {
		t.Fatalf("missing CoreDevice output: %v", err)
	}
	input := channel.sent["CoreDevice.input"].(map[string]interface{})
	options := input["options"].(map[string]interface{})
	session := options["avcMediaStreamOptionClientSessionID"].(map[string]interface{})
	if !bytes.Equal(input["negotiatorOffer"].([]byte), offer) || session["uuid"] != id ||
		options["VideoStreamForDisplayID"].(map[string]interface{})["int"] != int64(3) {
		t.Fatal("wrong offer or display routing")
	}
}
