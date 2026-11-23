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
	port      uint16
	started   chan negotiatedSession
	stopped   chan uuid.UUID
	startHook atomic.Pointer[func(context.Context, display.VideoStreamRequest) error]
	stopErr   atomic.Pointer[error]
	closed    atomic.Bool
}

func (s *stubDisplayService) StartVideoStreamWithOffer(ctx context.Context, req display.VideoStreamRequest, offer []byte) (uuid.UUID, map[string]interface{}, error) {
	if !bytes.HasPrefix(offer, []byte("bplist00")) {
		return uuid.Nil, nil, fmt.Errorf("invalid offer")
	}
	if hookPtr := s.startHook.Load(); hookPtr != nil && *hookPtr != nil {
		if err := (*hookPtr)(ctx, req); err != nil {
			return uuid.Nil, nil, err
		}
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
	if errPtr := s.stopErr.Load(); errPtr != nil && *errPtr != nil {
		select {
		case s.stopped <- id:
		default:
		}
		return *errPtr
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

type stubDecoder struct {
	resets   atomic.Int32
	onDecode chan byte
}

func (d *stubDecoder) decode(unit accessUnit, codec string) (decodedPicture, error) {
	nals := annexNALs(unit.annexB)
	last := nals[len(nals)-1]
	if d.onDecode != nil {
		select {
		case d.onDecode <- last[1]:
		default:
		}
	}
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

type hookEncoder struct {
	stubEncoder
	onEncode func(call int, key bool)
}

func (e *hookEncoder) encode(p decodedPicture, width, height, fps int, pts uint64, key bool) (encodedPicture, error) {
	n := int(e.calls.Add(1))
	if e.onEncode != nil {
		e.onEncode(n, key)
	}
	if key {
		return encodedPicture{testAnnex([]byte{0x67, 0x64, 0, 0x2a}, []byte{0x68, 1}, []byte{0x65, p.rgba[0]}), true, "avc1.64002a"}, nil
	}
	return encodedPicture{annexB: testAnnex([]byte{0x41, p.rgba[0]})}, nil
}

func TestRequestKeyframePreservedWhenArrivingMidEncode(t *testing.T) {
	dir, err := os.MkdirTemp("/tmp", "iphone-media-mid-")
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
	dec := &stubDecoder{}
	var p *Pipeline
	enc := &hookEncoder{
		onEncode: func(call int, key bool) {
			// While the second frame (a delta) is encoding, fire RequestKeyframe.
			if call == 2 && !key {
				p.RequestKeyframe()
			}
		},
	}
	p, err = newPipeline(PipelineConfig{
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
	dest := &net.UDPAddr{IP: transport.LocalIP(), Port: session.request.ReceiverPort}

	// Frame 0 (keyframe)
	keyPayload := aggregation([]byte{0x78}, []byte{0x67, 0x64, 0, 0x2a}, []byte{0x68, 1}, []byte{0x65, 1})
	if _, err := phone.WriteTo(testRTP(1, 1500, 42, 123, true, keyPayload), dest); err != nil {
		t.Fatal(err)
	}
	f0, _ := readTestFrame(t, view)
	if !f0.Key || f0.Sequence != 0 {
		t.Fatalf("unexpected frame 0: %+v", f0)
	}
	writeTestACK(t, view, 0)

	// Frame 1 (delta) triggers RequestKeyframe mid-encode; sequence 2 must follow as a keyframe.
	if _, err := phone.WriteTo(testRTP(2, 3000, 42, 123, true, []byte{0x41, 2}), dest); err != nil {
		t.Fatal(err)
	}
	f1, _ := readTestFrame(t, view)
	if f1.Key || f1.Sequence != 1 {
		t.Fatalf("unexpected frame 1: %+v", f1)
	}
	writeTestACK(t, view, 1)

	f2, _ := readTestFrame(t, view)
	if !f2.Key || f2.Sequence != 2 {
		t.Fatalf("mid-encode RequestKeyframe was lost: %+v", f2)
	}
}

func TestPipelineDemandPauseAndResumeStaticScreen(t *testing.T) {
	dir, err := os.MkdirTemp("/tmp", "iphone-media-pause-")
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
	events := make(chan DisplayEvent, 16)
	dec, enc := &stubDecoder{onDecode: make(chan byte, 8)}, &stubEncoder{}
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
	if _, err := p.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	session := receiveTestValue(t, svc.started)
	if e := receiveTestValue(t, events); e.State != "starting" || e.Generation != 1 {
		t.Fatalf("unexpected starting event: %+v", e)
	}
	view, err := net.Dial("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	defer view.Close()
	dest := &net.UDPAddr{IP: transport.LocalIP(), Port: session.request.ReceiverPort}
	keyPayload := aggregation([]byte{0x78}, []byte{0x67, 0x64, 0, 0x2a}, []byte{0x68, 1}, []byte{0x65, 5})
	if _, err := phone.WriteTo(testRTP(1, 1500, 42, 123, true, keyPayload), dest); err != nil {
		t.Fatal(err)
	}
	_ = receiveTestValue(t, dec.onDecode)
	f0, _ := readTestFrame(t, view)
	if !f0.Key || f0.Generation != 1 || f0.Sequence != 0 {
		t.Fatalf("unexpected initial frame: %+v", f0)
	}
	writeTestACK(t, view, 0)
	if e := receiveTestValue(t, events); e.State != "live" || e.Generation != 1 {
		t.Fatalf("unexpected live event: %+v", e)
	}

	// Pause demand: generation bumps, paused event emitted, RTP stays open, no outbound frames encoded.
	p.SetDemandActive(false)
	if e := receiveTestValue(t, events); e.State != "protected" || e.Reason != "paused" || e.Generation != 2 {
		t.Fatalf("unexpected paused event: %+v", e)
	}
	if len(svc.stopped) != 0 {
		t.Fatal("demand pause tore down CoreDevice RTP stream")
	}
	callsBefore := enc.calls.Load()
	if _, err := phone.WriteTo(testRTP(2, 3000, 42, 123, true, []byte{0x41, 9}), dest); err != nil {
		t.Fatal(err)
	}
	if decoded := receiveTestValue(t, dec.onDecode); decoded != 9 {
		t.Fatalf("unexpected decoded pixel marker: %d", decoded)
	}
	if enc.calls.Load() != callsBefore {
		t.Fatal("pipeline encoded outbound frames while demand-paused")
	}
	// Agent observation LatestFrame still works while demand-paused.
	if frame, ok := p.LatestFrame(time.Second); !ok || frame == nil {
		t.Fatal("LatestFrame unavailable while demand-paused")
	}

	// Simulate static screen (pictureAt older than maxUnackedAge) before resuming demand.
	p.mu.Lock()
	p.pictureAt = time.Now().Add(-2 * time.Second)
	p.mu.Unlock()
	p.SetDemandActive(true)
	if e := receiveTestValue(t, events); e.State != "starting" || e.Generation != 3 {
		t.Fatalf("unexpected resume starting event: %+v", e)
	}
	if p.needInboundKey.Load() {
		t.Fatal("resume requested inbound PLI despite warm decoded picture")
	}
	resumed, payload := readTestFrame(t, view)
	nals := annexNALs(payload)
	if !resumed.Key || resumed.Generation != 3 || resumed.Sequence != 1 || nals[len(nals)-1][1] != 9 {
		t.Fatalf("unexpected resumed static keyframe: %+v %x", resumed, payload)
	}
	writeTestACK(t, view, 1)
	if e := receiveTestValue(t, events); e.State != "live" || e.Generation != 3 {
		t.Fatalf("unexpected resumed live event: %+v", e)
	}
	if len(svc.stopped) != 0 {
		t.Fatal("demand pause/resume stopped CoreDevice RTP stream")
	}

	// Privacy hide + ResumeVisible while demandPaused must stay paused and not reopen RTP until SetDemandActive(true).
	p.SetDemandActive(false)
	if e := receiveTestValue(t, events); e.State != "protected" || e.Reason != "paused" || e.Generation != 4 {
		t.Fatalf("unexpected second pause event: %+v", e)
	}
	p.SetPrivacyHidden("protected", "locked-screen")
	if e := receiveTestValue(t, events); e.State != "protected" || e.Reason != "locked-screen" || e.Generation != 5 {
		t.Fatalf("unexpected privacy event while paused: %+v", e)
	}
	_ = receiveTestValue(t, svc.stopped)
	p.ResumeVisible(1, 0)
	if e := receiveTestValue(t, events); e.State != "protected" || e.Reason != "paused" || e.Generation != 6 {
		t.Fatalf("ResumeVisible while paused did not stay paused: %+v", e)
	}
	time.Sleep(60 * time.Millisecond)
	if len(svc.started) != 0 {
		t.Fatal("ResumeVisible opened RTP while still demand-paused")
	}
	p.SetDemandActive(true)
	if e := receiveTestValue(t, events); e.State != "starting" || e.Generation != 7 {
		t.Fatalf("SetDemandActive(true) after ResumeVisible did not start: %+v", e)
	}
	reopened := receiveTestValue(t, svc.started)
	dest2 := &net.UDPAddr{IP: transport.LocalIP(), Port: reopened.request.ReceiverPort}
	if _, err := phone.WriteTo(testRTP(1, 1500, 42, 123, true, keyPayload), dest2); err != nil {
		t.Fatal(err)
	}
	f2, _ := readTestFrame(t, view)
	if !f2.Key || f2.Generation != 7 {
		t.Fatalf("expected gen 7 keyframe after unpausing, got %+v", f2)
	}
}

func TestPipelineSurvivesScopedStopFailureOnPrivacyHide(t *testing.T) {
	dir, err := os.MkdirTemp("/tmp", "iphone-media-stoperr-")
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
	events := make(chan DisplayEvent, 16)
	dec, enc := &stubDecoder{onDecode: make(chan byte, 8)}, &stubEncoder{}
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
	if _, err := p.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	first := receiveTestValue(t, svc.started)
	_ = receiveTestValue(t, events) // starting
	view, err := net.Dial("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	defer view.Close()
	dest := &net.UDPAddr{IP: transport.LocalIP(), Port: first.request.ReceiverPort}
	keyPayload := aggregation([]byte{0x78}, []byte{0x67, 0x64, 0, 0x2a}, []byte{0x68, 1}, []byte{0x65, 3})
	if _, err := phone.WriteTo(testRTP(1, 1500, 42, 123, true, keyPayload), dest); err != nil {
		t.Fatal(err)
	}
	f0, _ := readTestFrame(t, view)
	writeTestACK(t, view, f0.Sequence)
	_ = receiveTestValue(t, events) // live

	// Inject a CoreDevice StopMediaStreamScoped timeout during privacy hide.
	stopTimeout := context.DeadlineExceeded
	svc.stopErr.Store(&stopTimeout)
	p.SetPrivacyHidden("protected", "locked-screen")
	if e := receiveTestValue(t, events); e.State != "protected" || e.Reason != "locked-screen" || e.Generation != 2 {
		t.Fatalf("unexpected protected event: %+v", e)
	}
	if id := receiveTestValue(t, svc.stopped); id != first.id {
		t.Fatalf("stopped wrong stream id: %v", id)
	}

	// Pipeline must remain alive, retry stopping the orphaned remote ID, and recover cleanly on ResumeVisible.
	svc.stopErr.Store(nil)
	p.ResumeVisible(1, 0)
	if e := receiveTestValue(t, events); e.State != "starting" || e.Generation != 3 {
		t.Fatalf("pipeline died or failed to resume after scoped stop error: %+v", e)
	}
	if retried := receiveTestValue(t, svc.stopped); retried != first.id {
		t.Fatalf("expected orphaned stream %v to be retried on resume, got %v", first.id, retried)
	}
	second := receiveTestValue(t, svc.started)
	dest2 := &net.UDPAddr{IP: transport.LocalIP(), Port: second.request.ReceiverPort}
	if _, err := phone.WriteTo(testRTP(1, 1500, 42, 123, true, keyPayload), dest2); err != nil {
		t.Fatal(err)
	}
	f1, _ := readTestFrame(t, view)
	if !f1.Key || f1.Generation != 3 {
		t.Fatalf("expected recovered keyframe at gen 3, got %+v", f1)
	}
	if e := receiveTestValue(t, events); e.State != "live" || e.Generation != 3 {
		t.Fatalf("expected live at gen 3, got %+v", e)
	}

	// Hide while a reopen is blocked in StartVideoStreamWithOffer: the superseded open error
	// must abort immediately without killing the pipeline, and a subsequent ResumeVisible recovers.
	p.SetPrivacyHidden("protected", "locked-screen")
	_ = receiveTestValue(t, events)
	_ = receiveTestValue(t, svc.stopped)
	openEntered := make(chan struct{}, 1)
	blockOpen := func(ctx context.Context, _ display.VideoStreamRequest) error {
		openEntered <- struct{}{}
		<-ctx.Done()
		return ctx.Err()
	}
	svc.startHook.Store(&blockOpen)
	p.ResumeVisible(1, 0)
	_ = receiveTestValue(t, events) // starting gen 5
	receiveTestValue(t, openEntered)
	p.SetPrivacyHidden("protected", "locked-screen")
	if e := receiveTestValue(t, events); e.State != "protected" || e.Reason != "locked-screen" {
		t.Fatalf("expected protected after cancelling in-flight open, got %+v", e)
	}
	svc.startHook.Store(nil)
	p.ResumeVisible(1, 0)
	if e := receiveTestValue(t, events); e.State != "starting" {
		t.Fatalf("pipeline died on superseded open error: %+v", e)
	}
	third := receiveTestValue(t, svc.started)
	dest3 := &net.UDPAddr{IP: transport.LocalIP(), Port: third.request.ReceiverPort}
	if _, err := phone.WriteTo(testRTP(1, 1500, 42, 123, true, keyPayload), dest3); err != nil {
		t.Fatal(err)
	}
	f2, _ := readTestFrame(t, view)
	if !f2.Key || f2.Generation < 7 {
		t.Fatalf("expected recovered keyframe after superseded open, got %+v", f2)
	}
}

func TestPipelineHideAndStopDoNotBlockOnStalledSocketWrite(t *testing.T) {
	dir, err := os.MkdirTemp("/tmp", "iphone-media-stall-")
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
	// Large frame payload to fill Unix socket send buffer when peer stops reading.
	bigEnc := &bigFrameEncoder{payloadSize: 200 * 1024}
	dec := &stubDecoder{}
	p, err := newPipeline(PipelineConfig{
		StreamID: testStreamID, DisplayID: 1, MaxFPS: 60, SocketPath: path,
	}, transport, svc, codecFactory{
		decoder: func() videoDecoder { return dec },
		encoder: func() videoEncoder { return bigEnc },
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = p.Stop(context.Background()) })
	if _, err := p.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	session := receiveTestValue(t, svc.started)
	view, err := net.DialUnix("unix", nil, &net.UnixAddr{Name: path, Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	defer view.Close()
	_ = view.SetReadBuffer(4096)

	dest := &net.UDPAddr{IP: transport.LocalIP(), Port: session.request.ReceiverPort}
	keyPayload := aggregation([]byte{0x78}, []byte{0x67, 0x64, 0, 0x2a}, []byte{0x68, 1}, []byte{0x65, 1})
	// Push 4 frames without reading from view so the Unix socket write blocks inside writeFrame.
	for i := uint16(1); i <= 4; i++ {
		payload := []byte{0x41, byte(i)}
		if i == 1 {
			payload = keyPayload
		}
		if _, err := phone.WriteTo(testRTP(i, uint32(i)*1500, 42, 123, true, payload), dest); err != nil {
			t.Fatal(err)
		}
		time.Sleep(25 * time.Millisecond)
	}

	// SetPrivacyHidden and Stop must complete promptly (<< 1s Unix write deadline).
	startHide := time.Now()
	p.SetPrivacyHidden("protected", "locked-screen")
	if elapsed := time.Since(startHide); elapsed > 300*time.Millisecond {
		t.Fatalf("SetPrivacyHidden blocked for %v behind stalled socket write", elapsed)
	}
	startStop := time.Now()
	stopCtx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()
	if err := p.Stop(stopCtx); err != nil {
		t.Fatalf("Stop failed or blocked behind stalled socket write: %v", err)
	}
	if elapsed := time.Since(startStop); elapsed > 400*time.Millisecond {
		t.Fatalf("Stop blocked for %v behind stalled socket write", elapsed)
	}
}

type bigFrameEncoder struct {
	payloadSize int
}

func (e *bigFrameEncoder) encode(_ decodedPicture, _, _, _ int, _ uint64, key bool) (encodedPicture, error) {
	nal := make([]byte, e.payloadSize)
	nal[0] = 0x41
	if key {
		nal[0] = 0x65
		return encodedPicture{testAnnex([]byte{0x67, 0x64, 0, 0x2a}, []byte{0x68, 1}, nal), true, "avc1.64002a"}, nil
	}
	return encodedPicture{annexB: testAnnex(nal)}, nil
}

func (*bigFrameEncoder) close() {}
