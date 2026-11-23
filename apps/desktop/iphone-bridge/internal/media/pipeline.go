package media

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/binary"
	"errors"
	"log/slog"
	"net"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"

	"github.com/danielpaulus/go-ios/ios/display"
	"github.com/google/uuid"
)

const (
	negotiationDeadline = 12 * time.Second
	scopedStopDeadline  = 2 * time.Second
	ingressPollInterval = 50 * time.Millisecond
	auQueueCapacity     = 8
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

type queuedAccessUnit struct {
	epoch uint64
	codec string
	unit  accessUnit
	at    time.Time
}

type Pipeline struct {
	udp     UDPTransport
	svc     DisplayService
	cfg     PipelineConfig
	codecMu sync.Mutex
	decoder videoDecoder
	encoder videoEncoder

	// Lock ordering: codecMu may acquire mu; mu must never acquire codecMu.
	mu                   sync.Mutex
	done                 chan struct{}
	codecDone            chan struct{}
	cancel               context.CancelFunc
	cancelOpen           context.CancelFunc
	wake                 chan struct{}
	encodeWake           chan struct{}
	auCh                 chan queuedAccessUnit
	needInboundKey       atomic.Bool
	stopping, hidden     bool
	demandPaused         bool
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
	keyframeSeq          uint64
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
		wake: make(chan struct{}, 1), encodeWake: make(chan struct{}, 1),
		auCh:       make(chan queuedAccessUnit, auQueueCapacity),
		generation: 1, forceKey: true,
	}, nil
}

func constrainDemand(longSide, fps int) (int, int) {
	return max(320, min(1920, longSide)), max(1, min(60, fps))
}

func (p *Pipeline) signalEncode() {
	select {
	case p.encodeWake <- struct{}{}:
	default:
	}
}

func (p *Pipeline) drainAccessUnits() {
	for {
		select {
		case item := <-p.auCh:
			clear(item.unit.annexB)
		default:
			return
		}
	}
}

func (p *Pipeline) closeCodecs() {
	p.drainAccessUnits()
	p.codecMu.Lock()
	p.decoder.close()
	p.encoder.close()
	p.codecMu.Unlock()
}

func (p *Pipeline) closeEncoder() {
	p.codecMu.Lock()
	p.encoder.close()
	p.codecMu.Unlock()
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
		if p.demandPaused {
			p.publishLocked("protected", "paused")
		} else {
			p.publishLocked("starting", "")
		}
	}
	listener, err := openMediaSocket(cfg.SocketPath)
	if err != nil {
		p.mu.Unlock()
		p.finish(nil, nil, err, "data-socket-failed")
		return "", err
	}
	p.listener = listener
	shouldOpen := !p.hidden && !p.demandPaused
	p.mu.Unlock()

	var stream *phoneStream
	if shouldOpen {
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
		p.finish(stream, nil, err, "capture-failed")
		return "", err
	}
	p.mu.Lock()
	if p.epoch == epoch && !p.stopping {
		p.stream = stream
	} else if stream != nil {
		_ = stream.conn.Close()
		if stream.audioConn != nil {
			_ = stream.audioConn.Close()
		}
	}
	stopping := p.stopping
	if !stopping {
		p.codecDone = make(chan struct{})
	}
	codecDone := p.codecDone
	p.mu.Unlock()
	if codecDone != nil {
		go p.runCodec(lifetime, codecDone)
	}
	go p.acceptSockets(listener)
	go p.runIngress(lifetime, stream, epoch)
	if stopping {
		return "", context.Canceled
	}
	return cfg.SocketPath, nil
}

func drainAudioConn(conn net.PacketConn) {
	buf := make([]byte, 4096)
	defer clear(buf)
	for {
		n, _, err := conn.ReadFrom(buf)
		if n > 0 {
			clear(buf[:n])
		}
		if err != nil {
			return
		}
	}
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
		go drainAudioConn(audioConn)
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

func (p *Pipeline) stopStreamID(id uuid.UUID) error {
	if id == uuid.Nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), scopedStopDeadline)
	defer cancel()
	return p.svc.StopMediaStreamScoped(ctx, id, false)
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
	return p.stopStreamID(stream.id)
}

// runIngress exclusively owns RTP/RTCP UDP I/O so codec work never stalls
// packet reception or causes gVisor UDP queue drops.
func (p *Pipeline) runIngress(ctx context.Context, stream *phoneStream, epoch uint64) {
	var err error
	var orphaned []uuid.UUID
	recordOrphan := func(id uuid.UUID) {
		if id == uuid.Nil {
			return
		}
		for _, existing := range orphaned {
			if existing == id {
				return
			}
		}
		if len(orphaned) >= 4 {
			orphaned = orphaned[1:]
		}
		orphaned = append(orphaned, id)
	}
	drainOrphans := func() {
		if len(orphaned) == 0 {
			return
		}
		remaining := orphaned[:0]
		for _, id := range orphaned {
			if ctx.Err() != nil {
				remaining = append(remaining, id)
				continue
			}
			if stopErr := p.stopStreamID(id); stopErr != nil {
				slog.Debug("bridge.display-stop-retry-failed", "error", stopErr)
				remaining = append(remaining, id)
			}
		}
		orphaned = remaining
	}
	defer func() { p.finish(stream, orphaned, err, "capture-failed") }()
	packet := make([]byte, 65536)
	defer clear(packet)
	for ctx.Err() == nil {
		p.mu.Lock()
		stopping, hidden, demandPaused, current, cfg := p.stopping, p.hidden, p.demandPaused, p.epoch, p.cfg
		p.mu.Unlock()
		if stopping {
			return
		}
		if stream != nil && (hidden || epoch != current) {
			if closeErr := p.closeStream(stream); closeErr != nil {
				slog.Debug("bridge.display-stop-failed", "error", closeErr)
				recordOrphan(stream.id)
			}
			stream = nil
		}
		if hidden || (stream == nil && demandPaused) {
			select {
			case <-p.wake:
			case <-ctx.Done():
			}
			continue
		}
		if stream == nil {
			drainOrphans()
			epoch = current
			p.needInboundKey.Store(false)
			openCtx, cancelOpen := context.WithCancel(ctx)
			p.mu.Lock()
			if p.stopping || p.hidden || p.demandPaused || p.epoch != epoch {
				p.mu.Unlock()
				cancelOpen()
				continue
			}
			p.cancelOpen = cancelOpen
			p.mu.Unlock()
			stream, err = p.openStream(openCtx, cfg)
			canceled := openCtx.Err() != nil && ctx.Err() == nil
			p.mu.Lock()
			p.cancelOpen = nil
			stopping := p.stopping
			superseded := canceled || stopping || p.hidden || p.demandPaused || p.epoch != epoch
			if err == nil && !superseded {
				p.stream = stream
			}
			p.mu.Unlock()
			cancelOpen()
			if err != nil {
				if superseded {
					err = nil
					continue
				}
				return
			}
			if stopping {
				return
			}
			if superseded && stream != nil {
				if closeErr := p.closeStream(stream); closeErr != nil {
					slog.Debug("bridge.display-stop-failed", "error", closeErr)
					recordOrphan(stream.id)
				}
				stream = nil
			}
			continue
		}

		if err = stream.conn.SetReadDeadline(time.Now().Add(ingressPollInterval)); err == nil {
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
			if p.needInboundKey.Swap(false) {
				stream.feedback.needKey = true
			}
			p.receiveIngress(stream, epoch, packet[:n], now)
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

func (p *Pipeline) receiveIngress(stream *phoneStream, epoch uint64, datagram []byte, now time.Time) {
	emit := func(unit accessUnit) {
		if unit.key {
			stream.feedback.gotKeyframe()
		}
		queued := queuedAccessUnit{
			epoch: epoch,
			codec: stream.answer.Codec,
			unit:  accessUnit{annexB: bytes.Clone(unit.annexB), timestamp: unit.timestamp, key: unit.key},
			at:    now,
		}
		select {
		case p.auCh <- queued:
		default:
			if unit.key {
				p.drainAccessUnits()
				select {
				case p.auCh <- queued:
					return
				default:
				}
			}
			clear(queued.unit.annexB)
			stream.receiver.synced = false
			stream.feedback.needKey = true
		}
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
			_ = stream.conn.SetWriteDeadline(time.Now().Add(ingressPollInterval))
			_, _ = stream.conn.WriteTo(feedback, stream.remote)
		}
	}
}

// runCodec decodes queued access units and hardware-encodes output frames
// independently of UDP reception.
func (p *Pipeline) runCodec(ctx context.Context, done chan struct{}) {
	defer close(done)
	defer p.closeCodecs()

	var paceTimer *time.Timer
	var paceCh <-chan time.Time
	armPace := func(wait time.Duration) {
		if wait <= 0 {
			wait = time.Millisecond
		}
		if paceTimer == nil {
			paceTimer = time.NewTimer(wait)
		} else {
			if !paceTimer.Stop() {
				select {
				case <-paceTimer.C:
				default:
				}
			}
			paceTimer.Reset(wait)
		}
		paceCh = paceTimer.C
	}
	stopPace := func() {
		if paceTimer != nil {
			if !paceTimer.Stop() {
				select {
				case <-paceTimer.C:
				default:
				}
			}
		}
		paceCh = nil
	}
	defer stopPace()

	for {
		select {
		case <-ctx.Done():
			return
		case item := <-p.auCh:
			p.handleAccessUnit(item)
			if wait := p.tryEncode(time.Now()); wait > 0 {
				armPace(wait)
			} else {
				stopPace()
			}
		case <-p.encodeWake:
			if wait := p.tryEncode(time.Now()); wait > 0 {
				armPace(wait)
			} else {
				stopPace()
			}
		case <-paceCh:
			paceCh = nil
			if wait := p.tryEncode(time.Now()); wait > 0 {
				armPace(wait)
			}
		}
	}
}

func (p *Pipeline) handleAccessUnit(item queuedAccessUnit) {
	defer clear(item.unit.annexB)
	p.codecMu.Lock()
	defer p.codecMu.Unlock()

	p.mu.Lock()
	stale := p.epoch != item.epoch || p.hidden || p.stopping
	p.mu.Unlock()
	if stale {
		return
	}

	picture, err := p.decoder.decode(item.unit, item.codec)
	if err != nil {
		p.decoder.close()
		p.needInboundKey.Store(true)
		return
	}
	if !picture.valid() {
		picture.release()
		return
	}

	p.mu.Lock()
	if p.epoch != item.epoch || p.hidden || p.stopping {
		p.mu.Unlock()
		picture.release()
		return
	}
	dimChanged := p.picture.width != picture.width || p.picture.height != picture.height
	if dimChanged {
		if p.picture.width != 0 {
			p.generation++
			p.width, p.height = 0, 0
			p.clearLatestLocked()
		}
		p.forceKey = true
	}
	oldPic := p.picture
	p.picture, p.pictureAt = picture, item.at
	p.mu.Unlock()
	oldPic.release()
	if dimChanged {
		p.encoder.close()
	}
}

// tryEncode returns a positive duration when an unencoded frame is ready and
// only waiting on FPS pacing.
func (p *Pipeline) tryEncode(now time.Time) time.Duration {
	p.codecMu.Lock()

	p.mu.Lock()
	if p.hidden || p.demandPaused || p.stopping || p.socket == nil || !p.socket.credit(now) ||
		!p.picture.valid() || !p.pictureAt.After(p.lastEncodedAt) || (!p.forceKey && now.Sub(p.pictureAt) >= maxUnackedAge) {
		p.mu.Unlock()
		p.codecMu.Unlock()
		return 0
	}
	if now.Before(p.nextEncode) {
		wait := p.nextEncode.Sub(now)
		p.mu.Unlock()
		p.codecMu.Unlock()
		return wait
	}
	pic := p.picture.retain()
	if !pic.valid() {
		p.mu.Unlock()
		p.codecMu.Unlock()
		return 0
	}
	epoch := p.epoch
	sock := p.socket
	cfg := p.cfg
	generation := p.generation
	sequence := p.sequence
	forceKey := p.forceKey
	keyframeSeq := p.keyframeSeq
	pictureAt := p.pictureAt
	if p.firstFrameAt.IsZero() {
		p.firstFrameAt = pictureAt
	}
	ptsAt := pictureAt
	if forceKey && now.After(ptsAt) {
		ptsAt = now
	}
	pts := uint64(max(0, ptsAt.Sub(p.firstFrameAt).Microseconds()))
	if sequence > 0 {
		pts = max(p.lastPTS+1, pts)
	}
	p.mu.Unlock()

	width, height := scaledDimensions(pic.width, pic.height, cfg.MaxLongSide, true)
	encoded, err := p.encoder.encode(pic, width, height, cfg.MaxFPS, pts, forceKey)
	pic.release()
	if err != nil || (forceKey && !encoded.key) {
		clear(encoded.annexB)
		p.encoder.close()
		p.codecMu.Unlock()
		p.mu.Lock()
		p.forceKey = true
		if err != nil && p.width == 0 && p.epoch == epoch && !p.hidden && !p.demandPaused && !p.stopping {
			p.publishLocked("failed", "encoder-failed")
		}
		p.mu.Unlock()
		return 0
	}
	envelope, err := encodeDisplayMediaFrame(mediaFrameHeader{
		StreamID: cfg.StreamID, Generation: generation, Sequence: sequence,
		PTSUs: pts, Key: encoded.key, Codec: encoded.codec, Width: width, Height: height,
	}, encoded.annexB)
	clear(encoded.annexB)
	if err != nil {
		p.encoder.close()
		p.codecMu.Unlock()
		p.mu.Lock()
		p.forceKey = true
		p.mu.Unlock()
		return 0
	}
	// Release codecMu before writing to the Unix socket so a slow reader never
	// blocks SetPrivacyHidden/closeCodecs or Stop.
	p.codecMu.Unlock()
	defer clear(envelope)

	p.mu.Lock()
	if p.epoch != epoch || p.hidden || p.demandPaused || p.stopping || p.socket != sock ||
		p.generation != generation || p.cfg.MaxLongSide != cfg.MaxLongSide || p.cfg.MaxFPS != cfg.MaxFPS {
		p.mu.Unlock()
		return 0
	}
	if err := sock.reserve(sequence, len(envelope), now); err != nil {
		p.forceKey = true
		p.mu.Unlock()
		p.closeEncoder()
		return 0
	}
	p.nextEncode = now.Add(time.Second / time.Duration(cfg.MaxFPS))
	p.sequence++
	p.lastPTS = pts
	// Preserve any RequestKeyframe that arrived while this frame was encoding.
	pendingRefresh := p.keyframeSeq != keyframeSeq
	if !pendingRefresh {
		p.lastEncodedAt = pictureAt
		p.forceKey = false
	}
	p.mu.Unlock()

	if err := sock.writeFrame(envelope); err != nil {
		p.mu.Lock()
		if p.socket == sock {
			p.dropSocketLocked()
		}
		p.mu.Unlock()
		p.closeEncoder()
		return 0
	}

	p.mu.Lock()
	if p.epoch == epoch && !p.hidden && !p.demandPaused && !p.stopping && p.socket == sock &&
		p.generation == generation && (p.width != width || p.height != height) {
		p.width, p.height = width, height
		p.publishLocked("live", "")
	}
	p.mu.Unlock()
	if pendingRefresh {
		p.signalEncode()
	}
	return 0
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
		p.forceKey = true
		p.lastEncodedAt = time.Time{}
		needKey := !p.picture.valid() && !p.hidden && !p.demandPaused
		p.mu.Unlock()
		p.closeEncoder()
		if needKey {
			p.needInboundKey.Store(true)
		}
		p.signalEncode()
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
			p.closeEncoder()
			return
		}
		socket.ack(seq)
		p.mu.Unlock()
		p.signalEncode()
	}
}

func (p *Pipeline) dropSocketLocked() {
	if p.socket != nil {
		_ = p.socket.conn.Close()
		p.socket = nil
	}
	p.forceKey = true
}

// ApplyDemand atomically applies profile and active-viewer demand updates under
// a single lock acquisition so concurrent demand calls never interleave stale
// profiles with pause/resume transitions.
func (p *Pipeline) ApplyDemand(maxLongSide, maxFPS *int, active *bool) {
	p.mu.Lock()
	if p.stopping {
		p.mu.Unlock()
		return
	}
	nextLongSide, nextFPS := p.cfg.MaxLongSide, p.cfg.MaxFPS
	if maxLongSide != nil && *maxLongSide > 0 {
		nextLongSide = *maxLongSide
	}
	if maxFPS != nil && *maxFPS > 0 {
		nextFPS = *maxFPS
	}
	longSide, fps := constrainDemand(nextLongSide, nextFPS)
	profileChanged := longSide != p.cfg.MaxLongSide || fps != p.cfg.MaxFPS
	prevPaused := p.demandPaused
	nextPaused := prevPaused
	if active != nil {
		nextPaused = !*active
	}
	pauseChanged := nextPaused != prevPaused

	var closeEnc, needInbound, signalEnc bool
	if profileChanged {
		if !pauseChanged && !nextPaused && longSide != p.cfg.MaxLongSide && p.width != 0 {
			width, height := scaledDimensions(p.picture.width, p.picture.height, longSide, true)
			if width != p.width || height != p.height {
				p.generation++
				p.width, p.height = 0, 0
			}
		}
		p.cfg.MaxLongSide, p.cfg.MaxFPS = longSide, fps
		p.forceKey = true
		p.lastEncodedAt = time.Time{}
		closeEnc = true
		if !nextPaused {
			signalEnc = true
		}
	}
	if pauseChanged {
		p.demandPaused = nextPaused
		if nextPaused {
			if p.cancelOpen != nil {
				p.cancelOpen()
				p.cancelOpen = nil
			}
			if !p.hidden {
				p.generation++
				p.width, p.height = 0, 0
				p.forceKey = true
				if p.done != nil {
					p.publishLocked("protected", "paused")
				}
			}
			closeEnc = true
			signalEnc = false
		} else if !p.hidden {
			p.generation++
			p.width, p.height = 0, 0
			p.forceKey = true
			p.lastEncodedAt = time.Time{}
			p.nextEncode = time.Time{}
			needInbound = !p.picture.valid()
			if p.done != nil {
				p.publishLocked("starting", "")
			}
			select {
			case p.wake <- struct{}{}:
			default:
			}
			signalEnc = true
		}
	}
	p.mu.Unlock()
	if closeEnc {
		p.closeEncoder()
	}
	if needInbound {
		p.needInboundKey.Store(true)
	}
	if signalEnc {
		p.signalEncode()
	}
}

func (p *Pipeline) UpdateDemand(maxLongSide, maxFPS int) {
	var sidePtr, fpsPtr *int
	if maxLongSide > 0 {
		sidePtr = &maxLongSide
	}
	if maxFPS > 0 {
		fpsPtr = &maxFPS
	}
	p.ApplyDemand(sidePtr, fpsPtr, nil)
}

// SetDemandActive pauses or resumes outbound video encoding when viewers come
// and go, without tearing down the CoreDevice RTP stream or invalidating the
// warm decoded picture used by agent observations and rapid viewer reconnects.
func (p *Pipeline) SetDemandActive(active bool) {
	p.ApplyDemand(nil, nil, &active)
}

// RequestKeyframe forces a fresh outbound H.264 IDR locally without requesting
// an inbound iPhone PLI/FIR whenever a healthy decoded frame is already held.
func (p *Pipeline) RequestKeyframe() {
	p.mu.Lock()
	if p.stopping {
		p.mu.Unlock()
		return
	}
	p.keyframeSeq++
	p.forceKey = true
	p.lastEncodedAt = time.Time{}
	p.nextEncode = time.Time{}
	needInbound := !p.picture.valid() && !p.hidden && !p.demandPaused
	p.mu.Unlock()
	if needInbound {
		p.needInboundKey.Store(true)
	}
	p.signalEncode()
}

// LatestFrame materializes RGBA and JPEG only on demand for agent observation,
// keeping normal Live View streaming completely free of CPU pixel conversions.
func (p *Pipeline) LatestFrame(maxAge time.Duration) (*VideoFrame, bool) {
	p.mu.Lock()
	if p.hidden || p.stopping {
		p.mu.Unlock()
		return nil, false
	}
	if p.latest != nil && time.Since(p.latest.CapturedAt) <= maxAge &&
		!p.pictureAt.After(p.latest.CapturedAt.Add(100*time.Millisecond)) {
		latest := *p.latest
		latest.RGBA = bytes.Clone(latest.RGBA)
		latest.JPEG = bytes.Clone(latest.JPEG)
		p.mu.Unlock()
		return &latest, true
	}
	if !p.picture.valid() || time.Since(p.pictureAt) > maxAge {
		p.mu.Unlock()
		return nil, false
	}
	pic := p.picture.retain()
	if !pic.valid() {
		p.mu.Unlock()
		return nil, false
	}
	epoch := p.epoch
	capturedAt := p.pictureAt
	displayID := p.cfg.DisplayID
	rotation := p.cfg.Rotation
	p.mu.Unlock()
	defer pic.release()

	width, height := scaledDimensions(pic.width, pic.height, 1920, false)
	rgba, err := pic.materializeRGBA(width, height)
	if err != nil {
		return nil, false
	}
	jpeg, err := snapshotJPEG(decodedPicture{rgba: rgba, width: width, height: height})
	if err != nil {
		clear(rgba)
		return nil, false
	}

	p.mu.Lock()
	if p.hidden || p.stopping || p.epoch != epoch {
		p.mu.Unlock()
		clear(rgba)
		clear(jpeg)
		return nil, false
	}
	p.clearLatestLocked()
	p.latest = &VideoFrame{
		JPEG: jpeg, RGBA: rgba, Width: width, Height: height,
		DisplayID: displayID, Rotation: rotation, CapturedAt: capturedAt,
	}
	out := &VideoFrame{
		JPEG: bytes.Clone(jpeg), RGBA: bytes.Clone(rgba), Width: width, Height: height,
		DisplayID: displayID, Rotation: rotation, CapturedAt: capturedAt,
	}
	p.mu.Unlock()
	return out, true
}

func (p *Pipeline) SetPrivacyHidden(state, reason string) {
	p.mu.Lock()
	if p.stopping {
		p.mu.Unlock()
		return
	}
	if state != "screen-off" {
		state = "protected"
	}
	var oldPic decodedPicture
	changed := !p.hidden
	if changed {
		p.hidden = true
		p.generation++
		oldPic = p.resetStreamLocked()
	}
	p.publishLocked(state, reason)
	p.mu.Unlock()
	oldPic.release()
	if changed {
		p.closeCodecs()
	}
}

func (p *Pipeline) ResumeVisible(displayID uint64, rotation int) {
	if displayID == 0 {
		displayID = display.DefaultDisplayID
	}
	p.mu.Lock()
	if p.stopping || displayID > uint64(^uint(0)>>1) ||
		(!p.hidden && displayID == p.cfg.DisplayID && rotation == p.cfg.Rotation) {
		p.mu.Unlock()
		return
	}
	p.cfg.DisplayID, p.cfg.Rotation, p.hidden = displayID, rotation, false
	p.generation++
	oldPic := p.resetStreamLocked()
	if p.done != nil {
		if p.demandPaused {
			p.publishLocked("protected", "paused")
		} else {
			p.publishLocked("starting", "")
		}
	}
	p.mu.Unlock()
	oldPic.release()
	p.closeCodecs()
}

func (p *Pipeline) resetStreamLocked() decodedPicture {
	p.clearLatestLocked()
	oldPic := p.picture
	p.picture = decodedPicture{}
	p.pictureAt, p.lastEncodedAt = time.Time{}, time.Time{}
	p.width, p.height = 0, 0
	p.forceKey = true
	p.epoch++
	if p.cancelOpen != nil {
		p.cancelOpen()
		p.cancelOpen = nil
	}
	if p.stream != nil {
		// Only close the sockets here; runIngress owns stream.receiver and resets
		// it in closeStream once ReadFrom unblocks, avoiding concurrent map access.
		if p.stream.audioConn != nil {
			_ = p.stream.audioConn.Close()
		}
		_ = p.stream.conn.Close()
		p.stream = nil
	}
	select {
	case p.wake <- struct{}{}:
	default:
	}
	return oldPic
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
	var oldPic decodedPicture
	if !p.stopping {
		p.stopping = true
		oldPic = p.resetStreamLocked()
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
	oldPic.release()
	if unstarted {
		go p.finish(nil, nil, nil, "")
	}
	select {
	case <-done:
		return p.stopErr
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (p *Pipeline) finish(stream *phoneStream, orphaned []uuid.UUID, err error, reason string) {
	p.mu.Lock()
	stopped := p.stopping
	p.stopping = true
	oldPic := p.resetStreamLocked()
	p.dropSocketLocked()
	if p.listener != nil {
		_ = p.listener.Close()
	}
	if p.cancel != nil {
		p.cancel()
	}
	codecDone := p.codecDone
	p.mu.Unlock()
	oldPic.release()
	if codecDone != nil {
		<-codecDone
	} else {
		p.closeCodecs()
	}
	var orphanErrs []error
	for _, id := range orphaned {
		if stopErr := p.stopStreamID(id); stopErr != nil {
			orphanErrs = append(orphanErrs, stopErr)
		}
	}
	cleanupErr := errors.Join(append([]error{p.closeStream(stream), p.svc.Close()}, orphanErrs...)...)
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
