package phone

import (
	"bytes"
	"context"
	"github.com/danielpaulus/go-ios/ios/display"
	"github.com/danielpaulus/go-ios/ios/xpc"
	"testing"
	"time"
)

func TestDisplayNegotiationWire(t *testing.T) {
	incoming, outgoing := new(bytes.Buffer), new(bytes.Buffer)
	for range 2 {
		if err := xpc.EncodeMessage(incoming, xpc.Message{Flags: xpc.AlwaysSetFlag | xpc.DataFlag, Id: 1, Body: map[string]interface{}{"CoreDevice.output": map[string]interface{}{}}}); err != nil {
			t.Fatal(err)
		}
	}
	conn, err := xpc.New(outgoing, incoming, nil, nopCloser{})
	if err != nil {
		t.Fatal(err)
	}
	service := display.NewWithConnection(conn)
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	id, err := service.StartVideoStream(ctx, display.VideoStreamRequest{ReceiverIP: "fd00::1", ReceiverPort: 12345, SenderIP: "fd00::2", DisplayID: 1})
	if err != nil {
		t.Fatal(err)
	}
	if err := service.StopMediaStream(ctx, id); err != nil {
		t.Fatal(err)
	}
	start, err := xpc.DecodeMessage(outgoing)
	if err != nil {
		t.Fatal(err)
	}
	input := start.Body["CoreDevice.input"].(map[string]interface{})
	if input["receiverPort"] != uint64(12345) || input["negotiatorOffer"] == nil {
		t.Fatal("missing media negotiation")
	}
	stop, err := xpc.DecodeMessage(outgoing)
	if err != nil {
		t.Fatal(err)
	}
	stopInput := stop.Body["CoreDevice.input"].(map[string]interface{})
	if stopInput["stopAll"] != true {
		t.Fatal("device requires stopAll=true")
	}
	options := stopInput["avcMediaStreamOptionClientSessionID"].(map[string]interface{})
	if options["uuid"] != id {
		t.Fatal("wrong client session id")
	}
}
func TestMissingDeveloperModeIsUnknown(t *testing.T) {
	for _, value := range []map[string]interface{}{{}, {"DeveloperModeStatus": "false"}, {"DeveloperModeStatus": nil}} {
		if DeveloperModeStatus(value) != "unknown" {
			t.Fatal("missing/malformed status became disabled")
		}
	}
}
