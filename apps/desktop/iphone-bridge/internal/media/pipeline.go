package media

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/binary"
	"errors"
	"net"
	"path/filepath"
	"sync"
	"time"

	"github.com/danielpaulus/go-ios/ios/display"
	"github.com/google/uuid"
)

const (
	negotiationDeadline = 12 * time.Second
	scopedStopDeadline  = 2 * time.Second
	pollInterval        = 10 * time.Millisecond
)

type DisplayEvent struct {
	StreamID   string `json:"streamId"`
	State      string `json:"state"`
	Reason     string `json:"reason,omitempty"`
	Generation uint64 `json:"generation"`
	Width      int    `json:"width"`
	Height     int    `json:"height"`
	Rotation   int    `json:"rotation"`
}

type UDPTransport interface {
	ListenUDP(localPort uint16) (net.PacketConn, error)
	LocalIP() net.IP
	RemoteIP() net.IP
}

type DisplayService interface {
	StartVideoStreamWithOffer(ctx context.Context, req display.VideoStreamRequest, offer []byte) (uuid.UUID, map[string]interface{}, error)
	StopMediaStreamScoped(ctx context.Context, clientSessionID uuid.UUID, stopAll bool) error
	Close() error
}

type audioDisplayService interface {
	StartAudioStreamWithOffer(ctx context.Context, req display.AudioStreamRequest, offer []byte) (uuid.UUID, map[string]interface{}, error)
}

type PipelineConfig struct {
	StreamID    string
	DisplayID   uint64
	Rotation    int
	MaxLongSide int
	MaxFPS      int
	SocketPath  string
	OnState     func(DisplayEvent)
}

type phoneStream struct {
	audioConn net.PacketConn
	conn      net.PacketConn
	id        uuid.UUID
	answer    StreamAnswer
	remote    *net.UDPAddr
	receiver  rtpReceiver
	feedback  rtcpController
}

type Pipeline struct {
	udp     UDPTransport
	svc     DisplayService
	cfg     PipelineConfig
	decoder videoDecoder
	encoder videoEncoder

	mu                   sync.Mutex
	done                 chan struct{}
	cancel               context.CancelFunc
	wake                 chan struct{}
	stopping, hidden     bool
	stopErr              error
	listener             *net.UnixListener
	socket               *mediaSocket
	stream               *phoneStream
	epoch                uint64
	generation, sequence uint64
	lastPTS              uint64
	firstFrameAt         time.Time
	nextEncode           time.Time
	forceKey             bool
	latest               *VideoFrame
	picture              decodedPicture
	pictureAt            time.Time
	lastEncodedAt        time.Time
	width, height        int
	events               []DisplayEvent
	lastEvent            DisplayEvent
	publishing           bool
}

func NewPipeline(cfg PipelineConfig, udp UDPTransport, svc DisplayService) (*Pipeline, error) {
	codecs, err := nativeCodecs()
	if err != nil {
		return nil, err
	}
	return newPipeline(cfg, udp, svc, codecs)
}

func newPipeline(cfg PipelineConfig, udp UDPTransport, svc DisplayService, codecs codecFactory) (*Pipeline, error) {
	if !displayStreamID.MatchString(cfg.StreamID) || !filepath.IsAbs(cfg.SocketPath) || udp == nil || svc == nil {
		return nil, errors.New("invalid display pipeline configuration")
	}
	if cfg.DisplayID == 0 {
		cfg.DisplayID = display.DefaultDisplayID
	}
	if cfg.DisplayID > uint64(^uint(0)>>1) {
		return nil, errors.New("invalid display ID")
	}
	if cfg.MaxLongSide == 0 {
		cfg.MaxLongSide = 1280
	}
	if cfg.MaxFPS == 0 {
		cfg.MaxFPS = 30
	}
	cfg.MaxLongSide, cfg.MaxFPS = constrainDemand(cfg.MaxLongSide, cfg.MaxFPS)
	return &Pipeline{
		cfg: cfg, udp: udp, svc: svc,
		decoder: codecs.decoder(), encoder: codecs.encoder(),
		wake: make(chan struct{}, 1), generation: 1, forceKey: true,
	}, nil
}

func constrainDemand(longSide, fps int) (int, int) {
	return max(320, min(1920, longSide)), max(1, min(60, fps))
}

func (p *Pipeline) Start(ctx context.Context) (string, error) {
	p.mu.Lock()
	if p.done != nil || p.stopping {
		p.mu.Unlock()
		return "", errors.New("display pipeline already used")
	}
	lifetime, cancel := context.WithCancel(context.Background())
	p.cancel, p.done = cancel, make(chan struct{})
	epoch, cfg := p.epoch, p.cfg
	if !p.hidden {
		p.publishLocked("starting", "")
	}
	listener, err := openMediaSocket(cfg.SocketPath)
	if err != nil {
		p.mu.Unlock()
		p.finish(nil, err, "data-socket-failed")
		return "", err
	}
	p.listener = listener
	hidden := p.hidden
	p.mu.Unlock()

	var stream *phoneStream
	if !hidden {
		initial, stop := context.WithCancel(lifetime)
		unlink := context.AfterFunc(ctx, stop)
		if ctx.Err() != nil {
			stop()
		}
		stream, err = p.openStream(initial, cfg)
		unlink()
		stop()
	}
	if err == nil {
		err = ctx.Err()
	}
	if err != nil {
		p.finish(stream, err, "capture-failed")
		return "", err
	}
	p.mu.Lock()
	if p.epoch == epoch && !p.stopping {
		p.stream = stream
	} else if stream != nil {
		_ = stream.conn.Close()
	}
	stopping := p.stopping
	p.mu.Unlock()
	go p.acceptSockets(listener)
	go p.run(lifetime, stream, epoch)
	if stopping {
		return "", context.Canceled
	}
	return cfg.SocketPath, nil
}

func (p *Pipeline) openStream(parent context.Context, cfg PipelineConfig) (_ *phoneStream, err error) {
	local, remote := p.udp.LocalIP(), p.udp.RemoteIP()
	if local == nil || remote == nil {
		return nil, errors.New("display tunnel addresses unavailable")
	}
	if err := parent.Err(); err != nil {
		return nil, err
	}
	conn, err := p.udp.ListenUDP(0)
	if err != nil {
		return nil, err
	}
	stream := &phoneStream{conn: conn}
	defer func() {
		if err != nil {
			_ = p.closeStream(stream)
		}
	}()
	address, ok := conn.LocalAddr().(*net.UDPAddr)
	if !ok || address.Port < 1 || address.Port > 65535 {
		return nil, errors.New("invalid display UDP listener")
	}
	callID, err := uuid.NewRandom()
	if err != nil {
		return nil, err
	}
	var random [4]byte
	if _, err := rand.Read(random[:]); err != nil {
		return nil, err
	}
	sessionID := binary.BigEndian.Uint32(random[:])
	if sessionID == 0 {
		sessionID = 1
	}
	offer, err := BuildCleanVideoOffer(callID, sessionID, OfferOptions{
		DisplayID: cfg.DisplayID, MaxFPS: cfg.MaxFPS, PreferAVC: true,
	})
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(parent, negotiationDeadline)
	defer cancel()
	clientSessionID := uuid.New()
	if audioSvc, ok := p.svc.(audioDisplayService); ok {
		audioConn, err := p.udp.ListenUDP(0)
		if err != nil {
			return nil, err
		}
		stream.audioConn = audioConn
		audioAddr, ok := audioConn.LocalAddr().(*net.UDPAddr)
		if !ok || audioAddr.Port < 1 || audioAddr.Port > 65535 {
			return nil, errors.New("invalid display audio UDP listener")
		}
		audioCallID, err := uuid.NewRandom()
		if err != nil {
			return nil, err
		}
		var audioRand [4]byte
		if _, err := rand.Read(audioRand[:]); err != nil {
			return nil, err
		}
		audioSessionID := binary.BigEndian.Uint32(audioRand[:])
		if audioSessionID == 0 {
			audioSessionID = 1
		}
		audioOffer, err := BuildCleanAudioOffer(audioCallID, audioSessionID)
		if err != nil {
			return nil, err
		}
		audioReq := display.AudioStreamRequest{
			ReceiverIP: local.String(), ReceiverPort: audioAddr.Port,
			SenderIP: remote.String(), SenderPort: display.DefaultAudioSenderPort,
			ClientSessionID: clientSessionID,
		}
		audioID, _, err := audioSvc.StartAudioStreamWithOffer(ctx, audioReq, audioOffer)
		stream.id = audioID
		if err != nil {
			return nil, err
		}
	}
	req := display.VideoStreamRequest{
		ReceiverIP: local.String(), ReceiverPort: address.Port,
		SenderIP: remote.String(), SenderPort: display.DefaultVideoSenderPort,
		DisplayID: int(cfg.DisplayID), ClientSessionID: clientSessionID,
	}
	id, output, err := p.svc.StartVideoStreamWithOffer(ctx, req, offer)
	stream.id = id
	if err != nil {
		return nil, err
	}
	stream.answer, err = ParseVideoAnswer(output)
	if err != nil {
		return nil, err
	}
	stream.remote = &net.UDPAddr{IP: remote, Port: int(stream.answer.RemotePort)}
	if stream.answer.RemoteSSRC == 0 {
		stream.answer.RemoteSSRC = sessionID
	}
	stream.receiver.hevc = stream.answer.Codec == "hevc"
	stream.feedback = rtcpController{
		sender: stream.answer.RemoteSSRC, source: stream.answer.LocalSSRC,
		rate: stream.answer.ClockRate, cname: callID.String(), needKey: true,
	}
	return stream, nil
}

func (p *Pipeline) closeStream(stream *phoneStream) error {
	if stream == nil {
		return nil
	}
	if stream.audioConn != nil {
		_ = stream.audioConn.Close()
	}
	_ = stream.conn.Close()
	stream.receiver.reset()
	if stream.id == uuid.Nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), scopedStopDeadline)
	defer cancel()
	return p.svc.StopMediaStreamScoped(ctx, stream.id, false)
}

func (p *Pipeline) run(ctx context.Context, stream *phoneStream, epoch uint64) {
	var err error
	defer func() { p.finish(stream, err, "capture-failed") }()
	packet := make([]byte, 65536)
	defer clear(packet)
	for ctx.Err() == nil {
		p.mu.Lock()
		visible, current, cfg := !p.hidden && !p.stopping, p.epoch, p.cfg
		p.mu.Unlock()
		if stream != nil && (!visible || epoch != current) {
			err = p.closeStream(stream)
			stream = nil
			if err != nil {
				return
			}
		}
		if !visible {
			select {
			case <-p.wake:
			case <-ctx.Done():
			}
			continue
		}
		if stream == nil {
			epoch = current
			stream, err = p.openStream(ctx, cfg)
			if err != nil {
				return
			}
			p.mu.Lock()
			if p.epoch == epoch && !p.stopping {
				p.stream = stream
			}
			p.mu.Unlock()
			continue
		}

		if err = stream.conn.SetReadDeadline(time.Now().Add(pollInterval)); err == nil {
			var n int
			var source net.Addr
			n, source, err = stream.conn.ReadFrom(packet)
			received := packet[:n]
			if err != nil {
				n = 0
			} else {
				addr, ok := source.(*net.UDPAddr)
				if !ok || addr.Port <= 0 || addr.Port > 65535 || !addr.IP.Equal(stream.remote.IP) ||
					(stream.remote.Port != 0 && addr.Port != stream.remote.Port) {
					n = 0
				} else if stream.remote.Port == 0 {
					rtp, valid := parseRTP(packet[:n])
					if valid && rtp.ssrc == stream.answer.LocalSSRC && rtp.payloadType == stream.answer.PayloadType {
						stream.remote.Port = addr.Port
					} else {
						n = 0
					}
				}
			}
			now := time.Now()
			p.mu.Lock()
			currentSession := p.epoch == epoch && !p.hidden && !p.stopping
			if currentSession {
				p.receiveLocked(stream, packet[:n], now)
				p.tryEncodeLocked(now)
			}
			p.mu.Unlock()
			clear(received)
		}
		if err != nil {
			p.mu.Lock()
			stale := p.epoch != epoch || p.stopping
			p.mu.Unlock()
			var temporary net.Error
			if stale || (errors.As(err, &temporary) && temporary.Timeout()) {
				err = nil
				continue
			}
			return
		}
	}
}

func (p *Pipeline) receiveLocked(stream *phoneStream, datagram []byte, now time.Time) {
	emit := func(unit accessUnit) {
		picture, err := p.decoder.decode(unit, stream.answer.Codec)
		if err != nil {
			p.decoder.close()
			stream.receiver.synced = false
			stream.feedback.needKey = true
			return
		}
		if unit.key {
			stream.feedback.gotKeyframe()
		}
		if !validDimensions(picture.width, picture.height) || len(picture.rgba) != picture.width*picture.height*4 {
			clear(picture.rgba)
			return
		}
		if p.picture.width != picture.width || p.picture.height != picture.height {
			if p.picture.width != 0 {
				p.generation++
				p.width, p.height = 0, 0
				p.clearLatestLocked()
			}
			p.encoder.close()
			p.forceKey = true
		}
		clear(p.picture.rgba)
		p.picture, p.pictureAt = picture, now
		p.updateSnapshotLocked()
	}
	if isRTCP(datagram) {
		stream.feedback.receive(datagram, now)
	} else if packet, ok := parseRTP(datagram); ok && packet.ssrc == stream.answer.LocalSSRC &&
		packet.payloadType == stream.answer.PayloadType {
		accepted, lost := stream.receiver.push(packet, now, emit)
		if accepted {
			stream.feedback.record(packet, now)
		}
		stream.feedback.needKey = stream.feedback.needKey || lost
	}
	if stream.receiver.expire(now, emit) {
		stream.feedback.needKey = true
	}
	if stream.remote.Port != 0 {
		if feedback := stream.feedback.tick(now); len(feedback) != 0 {
			_ = stream.conn.SetWriteDeadline(time.Now().Add(pollInterval))
			_, _ = stream.conn.WriteTo(feedback, stream.remote)
		}
	}
}

func (p *Pipeline) updateSnapshotLocked() {
	if p.latest != nil && p.pictureAt.Sub(p.latest.CapturedAt) < 100*time.Millisecond {
		return
	}
	width, height := scaledDimensions(p.picture.width, p.picture.height, 1920, false)
	snapshot := scalePicture(p.picture, width, height)
	if width == p.picture.width && height == p.picture.height {
		snapshot.rgba = bytes.Clone(snapshot.rgba)
	}
	jpeg, err := snapshotJPEG(snapshot)
	if err != nil {
		clear(snapshot.rgba)
		return
	}
	p.clearLatestLocked()
	p.latest = &VideoFrame{JPEG: jpeg, RGBA: snapshot.rgba, Width: width, Height: height,
		DisplayID: p.cfg.DisplayID, Rotation: p.cfg.Rotation, CapturedAt: p.pictureAt}
}

func (p *Pipeline) tryEncodeLocked(now time.Time) {
	if p.socket == nil || !p.socket.credit(now) || now.Before(p.nextEncode) ||
		!p.pictureAt.After(p.lastEncodedAt) || now.Sub(p.pictureAt) >= maxUnackedAge {
		return
	}
	p.nextEncode = now.Add(time.Second / time.Duration(p.cfg.MaxFPS))
	p.lastEncodedAt = p.pictureAt
	if p.firstFrameAt.IsZero() {
		p.firstFrameAt = p.pictureAt
	}
	pts := uint64(p.pictureAt.Sub(p.firstFrameAt).Microseconds())
	if p.sequence > 0 {
		pts = max(p.lastPTS+1, pts)
	}
	width, height := scaledDimensions(p.picture.width, p.picture.height, p.cfg.MaxLongSide, true)
	picture := scalePicture(p.picture, width, height)
	encoded, err := p.encoder.encode(picture, p.cfg.MaxFPS, pts, p.forceKey)
	if picture.width != p.picture.width || picture.height != p.picture.height {
		clear(picture.rgba)
	}
	defer clear(encoded.annexB)
	if err != nil || (p.forceKey && !encoded.key) {
		p.resetEncoderLocked()
		if err != nil && p.width == 0 {
			p.publishLocked("failed", "encoder-failed")
		}
		return
	}
	envelope, err := encodeDisplayMediaFrame(mediaFrameHeader{
		StreamID: p.cfg.StreamID, Generation: p.generation, Sequence: p.sequence,
		PTSUs: pts, Key: encoded.key, Codec: encoded.codec, Width: width, Height: height,
	}, encoded.annexB)
	if err != nil {
		p.resetEncoderLocked()
		return
	}
	defer clear(envelope)
	if p.socket.totalBytes+len(envelope) > maxUnackedBytes {
		p.resetEncoderLocked()
		return
	}
	if err := p.socket.send(p.sequence, envelope); err != nil {
		p.dropSocketLocked()
		return
	}
	p.sequence++
	p.lastPTS = pts
	p.forceKey = false
	if p.width != width || p.height != height {
		p.width, p.height = width, height
		p.publishLocked("live", "")
	}
}

func (p *Pipeline) acceptSockets(listener *net.UnixListener) {
	for {
		conn, err := listener.AcceptUnix()
		if err != nil {
			return
		}
		p.mu.Lock()
		if p.stopping || p.socket != nil {
			p.mu.Unlock()
			_ = conn.Close()
			continue
		}
		socket := &mediaSocket{conn: conn}
		p.socket = socket
		p.resetEncoderLocked()
		p.lastEncodedAt = time.Time{}
		if p.stream != nil && !p.hidden {
			p.stream.feedback.needKey = true
		}
		p.mu.Unlock()
		go p.readACKs(socket)
	}
}

func (p *Pipeline) readACKs(socket *mediaSocket) {
	for {
		seq, err := socket.readACK()
		p.mu.Lock()
		if p.socket != socket {
			p.mu.Unlock()
			return
		}
		if err != nil {
			p.dropSocketLocked()
			p.mu.Unlock()
			return
		}
		socket.ack(seq)
		p.mu.Unlock()
	}
}

func (p *Pipeline) dropSocketLocked() {
	if p.socket != nil {
		_ = p.socket.conn.Close()
		p.socket = nil
	}
	p.resetEncoderLocked()
}

func (p *Pipeline) resetEncoderLocked() {
	p.encoder.close()
	p.forceKey = true
}

func (p *Pipeline) UpdateDemand(maxLongSide, maxFPS int) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.stopping {
		return
	}
	if maxLongSide <= 0 {
		maxLongSide = p.cfg.MaxLongSide
	}
	if maxFPS <= 0 {
		maxFPS = p.cfg.MaxFPS
	}
	longSide, fps := constrainDemand(maxLongSide, maxFPS)
	if longSide != p.cfg.MaxLongSide && p.width != 0 {
		width, height := scaledDimensions(p.picture.width, p.picture.height, longSide, true)
		if width != p.width || height != p.height {
			p.generation++
			p.width, p.height = 0, 0
		}
	}
	if longSide != p.cfg.MaxLongSide || fps != p.cfg.MaxFPS {
		p.cfg.MaxLongSide, p.cfg.MaxFPS = longSide, fps
		p.resetEncoderLocked()
		p.lastEncodedAt = time.Time{}
	}
}

func (p *Pipeline) RequestKeyframe() {
	p.mu.Lock()
	defer p.mu.Unlock()
	if !p.stopping {
		p.forceKey = true
		p.lastEncodedAt = time.Time{}
		if p.stream != nil && !p.hidden {
			p.stream.feedback.needKey = true
		}
	}
}

func (p *Pipeline) LatestFrame(maxAge time.Duration) (*VideoFrame, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.latest == nil || p.hidden || p.stopping || time.Since(p.latest.CapturedAt) > maxAge {
		return nil, false
	}
	latest := *p.latest
	latest.RGBA = bytes.Clone(latest.RGBA)
	latest.JPEG = bytes.Clone(latest.JPEG)
	return &latest, true
}

func (p *Pipeline) SetPrivacyHidden(state, reason string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.stopping {
		return
	}
	if state != "screen-off" {
		state = "protected"
	}
	if !p.hidden {
		p.hidden = true
		p.generation++
		p.resetStreamLocked()
	}
	p.publishLocked(state, reason)
}

func (p *Pipeline) ResumeVisible(displayID uint64, rotation int) {
	if displayID == 0 {
		displayID = display.DefaultDisplayID
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.stopping || displayID > uint64(^uint(0)>>1) ||
		(!p.hidden && displayID == p.cfg.DisplayID && rotation == p.cfg.Rotation) {
		return
	}
	p.cfg.DisplayID, p.cfg.Rotation, p.hidden = displayID, rotation, false
	p.generation++
	p.resetStreamLocked()
	if p.done != nil {
		p.publishLocked("starting", "")
	}
}

func (p *Pipeline) resetStreamLocked() {
	p.clearLatestLocked()
	clear(p.picture.rgba)
	p.picture = decodedPicture{}
	p.pictureAt, p.lastEncodedAt = time.Time{}, time.Time{}
	p.width, p.height = 0, 0
	p.decoder.close()
	p.resetEncoderLocked()
	p.epoch++
	if p.stream != nil {
		p.stream.receiver.reset()
		_ = p.stream.conn.Close()
		p.stream = nil
	}
	select {
	case p.wake <- struct{}{}:
	default:
	}
}

func (p *Pipeline) clearLatestLocked() {
	if p.latest != nil {
		clear(p.latest.RGBA)
		clear(p.latest.JPEG)
		p.latest = nil
	}
}

func (p *Pipeline) Stop(ctx context.Context) error {
	p.mu.Lock()
	unstarted := p.done == nil
	if unstarted {
		p.done = make(chan struct{})
	}
	if !p.stopping {
		p.stopping = true
		p.resetStreamLocked()
		p.dropSocketLocked()
		if p.listener != nil {
			_ = p.listener.Close()
		}
		if p.cancel != nil {
			p.cancel()
		}
	}
	done := p.done
	p.mu.Unlock()
	if unstarted {
		go p.finish(nil, nil, "")
	}
	select {
	case <-done:
		return p.stopErr
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (p *Pipeline) finish(stream *phoneStream, err error, reason string) {
	p.mu.Lock()
	stopped := p.stopping
	p.stopping = true
	p.resetStreamLocked()
	p.dropSocketLocked()
	if p.listener != nil {
		_ = p.listener.Close()
	}
	if p.cancel != nil {
		p.cancel()
	}
	p.mu.Unlock()
	cleanupErr := errors.Join(p.closeStream(stream), p.svc.Close())
	p.mu.Lock()
	p.stopErr = cleanupErr
	if err != nil && !stopped {
		p.publishLocked("failed", reason)
	} else {
		p.publishLocked("stopped", "")
	}
	close(p.done)
	p.mu.Unlock()
}

func (p *Pipeline) publishLocked(state, reason string) {
	if p.cfg.OnState == nil {
		return
	}
	event := DisplayEvent{
		StreamID: p.cfg.StreamID, Generation: p.generation, State: state, Reason: reason,
		Width: p.width, Height: p.height, Rotation: p.cfg.Rotation,
	}
	if event == p.lastEvent {
		return
	}
	p.lastEvent = event
	p.events = append(p.events, event)
	if !p.publishing {
		p.publishing = true
		go p.publishEvents()
	}
}

func (p *Pipeline) publishEvents() {
	for {
		p.mu.Lock()
		if len(p.events) == 0 {
			p.publishing = false
			p.mu.Unlock()
			return
		}
		event := p.events[0]
		p.events[0] = DisplayEvent{}
		p.events = p.events[1:]
		callback := p.cfg.OnState
		p.mu.Unlock()
		callback(event)
	}
}
