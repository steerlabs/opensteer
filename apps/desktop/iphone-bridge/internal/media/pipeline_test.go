package media

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/danielpaulus/go-ios/ios/display"
	"github.com/google/uuid"
)

type loopbackTransport struct{}

func (loopbackTransport) LocalIP() net.IP  { return net.IPv4(127, 0, 0, 1) }
func (loopbackTransport) RemoteIP() net.IP { return net.IPv4(127, 0, 0, 1) }
func (t loopbackTransport) ListenUDP(port uint16) (net.PacketConn, error) {
	return net.ListenUDP("udp4", &net.UDPAddr{IP: t.LocalIP(), Port: int(port)})
}

type negotiatedSession struct {
	id      uuid.UUID
	request display.VideoStreamRequest
}

type stubDisplayService struct {
	port    uint16
	started chan negotiatedSession
	stopped chan uuid.UUID
	closed  atomic.Bool
}

func (s *stubDisplayService) StartVideoStreamWithOffer(ctx context.Context, req display.VideoStreamRequest, offer []byte) (uuid.UUID, map[string]interface{}, error) {
	if !bytes.HasPrefix(offer, []byte("bplist00")) {
		return uuid.Nil, nil, fmt.Errorf("invalid offer")
	}
	id := uuid.New()
	select {
	case s.started <- negotiatedSession{id, req}:
	case <-ctx.Done():
		return uuid.Nil, nil, ctx.Err()
	}
	return id, map[string]interface{}{
		"senderPort": uint64(s.port), "localSSRC": uint64(42), "remoteSSRC": uint64(43),
		"payloadType": uint64(123), "codec": "avc", "clockRate": uint64(90000),
	}, nil
}

func (s *stubDisplayService) StopMediaStreamScoped(ctx context.Context, id uuid.UUID, stopAll bool) error {
	if stopAll {
		return fmt.Errorf("an unscoped stop was attempted")
	}
	select {
	case s.stopped <- id:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (s *stubDisplayService) Close() error {
	s.closed.Store(true)
	return nil
}

type stubDecoder struct{ resets atomic.Int32 }

func (d *stubDecoder) decode(unit accessUnit, codec string) (decodedPicture, error) {
	nals := annexNALs(unit.annexB)
	last := nals[len(nals)-1]
	return decodedPicture{rgba: bytes.Repeat([]byte{last[1], 0, 0, 255}, 28*16), width: 28, height: 16}, nil
}
func (d *stubDecoder) close() { d.resets.Add(1) }

type stubEncoder struct{ calls atomic.Int32 }

func (e *stubEncoder) encode(p decodedPicture, width, height, fps int, pts uint64, key bool) (encodedPicture, error) {
	e.calls.Add(1)
	if key {
		return encodedPicture{testAnnex([]byte{0x67, 0x64, 0, 0x2a}, []byte{0x68, 1}, []byte{0x65, p.rgba[0]}), true, "avc1.64002a"}, nil
	}
	return encodedPicture{annexB: testAnnex([]byte{0x41, p.rgba[0]})}, nil
}

func (*stubEncoder) close() {}

func receiveTestValue[T any](t *testing.T, ch <-chan T) T {
	t.Helper()
	select {
	case value := <-ch:
		return value
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for pipeline event")
		var zero T
		return zero
	}
}

func readTestFrame(t *testing.T, conn net.Conn) (mediaFrameHeader, []byte) {
	t.Helper()
	_ = conn.SetReadDeadline(time.Now().Add(time.Second))
	var socketHeader [5]byte
	if _, err := io.ReadFull(conn, socketHeader[:]); err != nil {
		t.Fatal(err)
	}
	size := binary.BigEndian.Uint32(socketHeader[1:])
	if socketHeader[0] != 1 || size > maxEnvelope || size <= 4 {
		t.Fatalf("invalid socket header %x", socketHeader)
	}
	b := make([]byte, size)
	if _, err := io.ReadFull(conn, b); err != nil {
		t.Fatal(err)
	}
	length := int(binary.BigEndian.Uint32(b))
	if length < 2 || length >= len(b)-4 {
		t.Fatalf("invalid envelope header length %d", length)
	}
	var header mediaFrameHeader
	if err := json.Unmarshal(b[4:4+length], &header); err != nil {
		t.Fatal(err)
	}
	return header, b[4+length:]
}

func writeTestACK(t *testing.T, conn net.Conn, seq uint64) {
	t.Helper()
	body := fmt.Appendf(nil, `{"type":"display.ack","sequence":%d}`, seq)
	wire := binary.BigEndian.AppendUint32([]byte{2}, uint32(len(body)))
	wire = append(wire, body...)
	for _, part := range [][]byte{wire[:3], wire[3:]} {
		if _, err := conn.Write(part); err != nil {
			t.Fatal(err)
		}
	}
}

func TestPipelineSocketCreditsAndPrivacy(t *testing.T) {
	// The short root also accommodates Darwin's 104-byte Unix socket path.
	dir, err := os.MkdirTemp("/tmp", "iphone-media-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	path := filepath.Join(dir, "media.sock")
	transport := loopbackTransport{}
	phone, err := transport.ListenUDP(0)
	if err != nil {
		t.Fatal(err)
	}
	defer phone.Close()
	svc := &stubDisplayService{
		port:    uint16(phone.LocalAddr().(*net.UDPAddr).Port),
		started: make(chan negotiatedSession, 4),
		stopped: make(chan uuid.UUID, 4),
	}
	events := make(chan DisplayEvent, 12)
	dec, enc := &stubDecoder{}, &stubEncoder{}
	p, err := newPipeline(PipelineConfig{
		StreamID: testStreamID, DisplayID: 1, MaxFPS: 60, SocketPath: path,
		OnState: func(e DisplayEvent) { events <- e },
	}, transport, svc, codecFactory{
		decoder: func() videoDecoder { return dec },
		encoder: func() videoEncoder { return enc },
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = p.Stop(context.Background()) })
	if sock, err := p.Start(context.Background()); err != nil || sock != path {
		t.Fatalf("socket %q, error %v", sock, err)
	}
	first := receiveTestValue(t, svc.started)
	if state := receiveTestValue(t, events); state.State != "starting" || state.Generation != 1 {
		t.Fatalf("wrong starting state: %+v", state)
	}
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0o600 || info.Mode()&os.ModeSocket == 0 {
		t.Fatalf("unexpected socket metadata: %v %v", info, err)
	}
	view, err := net.Dial("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	defer view.Close()
	send := func(session negotiatedSession, seq uint16, value byte, key bool) {
		t.Helper()
		payload := []byte{0x41, value}
		if key {
			payload = aggregation([]byte{0x78}, []byte{0x67, 0x64, 0, 0x2a}, []byte{0x68, 1}, []byte{0x65, value})
		}
		dest := &net.UDPAddr{IP: transport.LocalIP(), Port: session.request.ReceiverPort}
		if _, err := phone.WriteTo(testRTP(seq, uint32(seq)*1500, 42, 123, true, payload), dest); err != nil {
			t.Fatal(err)
		}
	}
	for i := uint16(0); i < 4; i++ {
		send(first, i, byte(i)+1, i == 0)
		header, payload := readTestFrame(t, view)
		nals := annexNALs(payload)
		if header.StreamID != testStreamID || header.Generation != 1 || header.Sequence != uint64(i) ||
			header.Key != (i == 0) || nals[len(nals)-1][1] != byte(i)+1 {
			t.Fatalf("unexpected frame: %+v %x", header, payload)
		}
	}
	if e := receiveTestValue(t, events); e.State != "live" || e.Width != 28 || e.Height != 16 {
		t.Fatalf("wrong live state: %+v", e)
	}
	for i := uint16(4); i < 9; i++ {
		send(first, i, byte(i)+1, false)
	}
	time.Sleep(60 * time.Millisecond)
	if calls := enc.calls.Load(); calls != 4 {
		t.Fatalf("encoded with no credit: %d calls", calls)
	}
	writeTestACK(t, view, 1) // An out-of-order credit must not release sequence zero.
	time.Sleep(30 * time.Millisecond)
	if calls := enc.calls.Load(); calls != 4 {
		t.Fatalf("accepted out-of-order ACK: %d calls", calls)
	}
	writeTestACK(t, view, 0)
	header, payload := readTestFrame(t, view)
	if header.Sequence != 4 || header.Key || !bytes.Equal(payload, testAnnex([]byte{0x41, 9})) {
		t.Fatalf("did not resume with latest delta: %+v %x", header, payload)
	}
	for i := uint64(1); i <= 4; i++ {
		writeTestACK(t, view, i)
	}
	frame, ok := p.LatestFrame(time.Second)
	if !ok || len(frame.JPEG) == 0 || len(frame.RGBA) != 28*16*4 {
		t.Fatal("decoded snapshot unavailable")
	}
	p.mu.Lock()
	cachedRGBA, cachedJPEG := p.latest.RGBA, p.latest.JPEG
	p.mu.Unlock()
	resets := dec.resets.Load()
	p.SetPrivacyHidden("protected", "locked-screen")
	if _, ok := p.LatestFrame(time.Second); ok || dec.resets.Load() <= resets ||
		!bytes.Equal(cachedRGBA, make([]byte, len(cachedRGBA))) || !bytes.Equal(cachedJPEG, make([]byte, len(cachedJPEG))) {
		t.Fatal("privacy did not flush the decoder and snapshot")
	}
	if e := receiveTestValue(t, events); e.State != "protected" || e.Generation != 2 || e.Reason != "locked-screen" {
		t.Fatalf("wrong privacy event: %+v", e)
	}
	if id := receiveTestValue(t, svc.stopped); id != first.id {
		t.Fatal("privacy stopped a different client session")
	}
	p.ResumeVisible(2, 90)
	second := receiveTestValue(t, svc.started)
	if second.id == first.id || second.request.DisplayID != 2 {
		t.Fatal("resume did not renegotiate the selected display")
	}
	if e := receiveTestValue(t, events); e.State != "starting" || e.Generation != 3 || e.Rotation != 90 {
		t.Fatalf("wrong resume event: %+v", e)
	}
	send(second, 1, 10, false)
	send(second, 2, 11, true)
	header, _ = readTestFrame(t, view)
	if header.Generation != 3 || header.Sequence != 5 || !header.Key {
		t.Fatalf("resumed without a newly decoded and encoded keyframe: %+v", header)
	}

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := p.Stop(ctx); err != nil {
		t.Fatal(err)
	}
	if id := receiveTestValue(t, svc.stopped); id != second.id || !svc.closed.Load() {
		t.Fatal("stop did not release the current session and service")
	}
	if _, err := os.Lstat(path); !os.IsNotExist(err) {
		t.Fatalf("socket path remains: %v", err)
	}
}

func TestCreditAgeAndBytes(t *testing.T) {
	now := time.Now()
	socket := mediaSocket{pending: []pendingACK{{5, maxUnackedBytes, now}}, totalBytes: maxUnackedBytes}
	if socket.credit(now) {
		t.Fatal("allowed credit at the byte limit")
	}
	socket.ack(5)
	socket.pending = append(socket.pending, pendingACK{6, 20, now})
	socket.totalBytes = 20
	if !socket.credit(now.Add(maxUnackedAge-time.Nanosecond)) || socket.credit(now.Add(maxUnackedAge)) {
		t.Fatal("incorrect ACK-age cutoff")
	}
	socket.ack(6)
	if !socket.credit(now.Add(maxUnackedAge)) {
		t.Fatal("ACK did not release aged credit")
	}
}

func TestRequestKeyframeGeneratesLocalIDRWithoutInboundPLI(t *testing.T) {
	dir, err := os.MkdirTemp("/tmp", "iphone-media-key-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	path := filepath.Join(dir, "media.sock")
	transport := loopbackTransport{}
	phone, err := transport.ListenUDP(0)
	if err != nil {
		t.Fatal(err)
	}
	defer phone.Close()
	svc := &stubDisplayService{
		port:    uint16(phone.LocalAddr().(*net.UDPAddr).Port),
		started: make(chan negotiatedSession, 2),
		stopped: make(chan uuid.UUID, 2),
	}
	dec, enc := &stubDecoder{}, &stubEncoder{}
	p, err := newPipeline(PipelineConfig{
		StreamID: testStreamID, DisplayID: 1, MaxFPS: 60, SocketPath: path,
	}, transport, svc, codecFactory{
		decoder: func() videoDecoder { return dec },
		encoder: func() videoEncoder { return enc },
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = p.Stop(context.Background()) })
	if _, err := p.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	session := receiveTestValue(t, svc.started)
	view, err := net.Dial("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	defer view.Close()

	// Send initial keyframe and acknowledge it.
	dest := &net.UDPAddr{IP: transport.LocalIP(), Port: session.request.ReceiverPort}
	payload := aggregation([]byte{0x78}, []byte{0x67, 0x64, 0, 0x2a}, []byte{0x68, 1}, []byte{0x65, 7})
	if _, err := phone.WriteTo(testRTP(1, 1500, 42, 123, true, payload), dest); err != nil {
		t.Fatal(err)
	}
	header, _ := readTestFrame(t, view)
	if !header.Key || header.Sequence != 0 {
		t.Fatalf("unexpected initial frame: %+v", header)
	}
	writeTestACK(t, view, 0)

	// RequestKeyframe with a healthy decoded picture must emit a local IDR without
	// asking the phone for an inbound PLI/FIR.
	p.RequestKeyframe()
	if p.needInboundKey.Load() {
		t.Fatal("RequestKeyframe requested an inbound PLI despite a healthy decoded picture")
	}
	refreshed, _ := readTestFrame(t, view)
	if !refreshed.Key || refreshed.Sequence != 1 {
		t.Fatalf("expected immediate local IDR on RequestKeyframe, got %+v", refreshed)
	}
}
