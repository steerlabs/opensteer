package phone

import (
	"bytes"
	"context"
	"io"
	"net"
	"sync"
	"testing"
	"time"

	"github.com/danielpaulus/go-ios/ios/display"
	"github.com/danielpaulus/go-ios/ios/xpc"
	"github.com/google/uuid"
)

type packetFixture struct {
	packets chan []byte
	done    chan struct{}
	once    sync.Once
}

func (p *packetFixture) ReadFrom(b []byte) (int, net.Addr, error) {
	select {
	case <-p.done:
		return 0, nil, io.EOF
	case data := <-p.packets:
		return copy(b, data), &net.UDPAddr{IP: net.ParseIP("fd00::2"), Port: 1111}, nil
	}
}
func (p *packetFixture) WriteTo([]byte, net.Addr) (int, error) { return 0, io.ErrClosedPipe }
func (p *packetFixture) LocalAddr() net.Addr {
	return &net.UDPAddr{IP: net.ParseIP("fd00::1"), Port: 9999}
}
func (p *packetFixture) Close() error                     { p.once.Do(func() { close(p.done) }); return nil }
func (p *packetFixture) SetDeadline(time.Time) error      { return nil }
func (p *packetFixture) SetReadDeadline(time.Time) error  { return nil }
func (p *packetFixture) SetWriteDeadline(time.Time) error { return nil }

type mediaFixture struct {
	packet  *packetFixture
	stopped chan uuid.UUID
	id      uuid.UUID
}

func (f *mediaFixture) StartVideoStream(context.Context, display.VideoStreamRequest) (uuid.UUID, error) {
	f.packet.packets <- []byte{0x80, 96, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0x65}
	return f.id, nil
}
func (f *mediaFixture) StopMediaStream(_ context.Context, id uuid.UUID) error {
	f.stopped <- id
	return nil
}
func (f *mediaFixture) Close() error { return nil }
func TestOwnedMediaDrainAndStop(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	p := &packetFixture{packets: make(chan []byte, 8), done: make(chan struct{})}
	f := &mediaFixture{packet: p, stopped: make(chan uuid.UUID, 2), id: uuid.New()}
	m, err := StartMedia(ctx, p, net.ParseIP("fd00::2"), func(context.Context) (MediaControl, error) { return f, nil })
	if err != nil {
		t.Fatal(err)
	}
	if !m.Ready() {
		t.Fatal("media declared ready before RTP")
	}
	if err := m.Close(); err != nil {
		t.Fatal(err)
	}
	if err := m.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case id := <-f.stopped:
		if id != f.id {
			t.Fatal("stopped another session")
		}
	default:
		t.Fatal("did not stop owned session")
	}
	select {
	case <-m.Done():
	case <-ctx.Done():
		t.Fatal("drain survived close")
	}
	if len(f.stopped) != 0 || m.Ready() {
		t.Fatal("non-idempotent cleanup")
	}
}
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
	if stopInput["stopAll"] != false {
		t.Fatal("global media stop")
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
