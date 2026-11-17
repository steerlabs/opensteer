package display

import (
	"context"
	"errors"
	"github.com/google/uuid"
	"io"
	"testing"
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
		err := service.StopMediaStream(context.Background(), uuid.New())
		if (err == nil) != test.want {
			t.Fatalf("send=%v receive=%v: %v", test.send, test.receive, err)
		}
		input := channel.sent["CoreDevice.input"].(map[string]interface{})
		if input["stopAll"] != true {
			t.Fatal("stop omitted stopAll=true")
		}
	}
	channel := &stopChannel{reply: map[string]interface{}{"CoreDevice.error": map[string]interface{}{"domain": "test", "code": int64(1)}}}
	if NewWithConnection(channel).StopMediaStream(context.Background(), uuid.New()) == nil {
		t.Fatal("explicit stop rejection became success")
	}
}
