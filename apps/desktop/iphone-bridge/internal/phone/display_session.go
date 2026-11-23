package phone

import (
	"context"
	"errors"
	"net"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/steerlabs/opensteer/iphone-bridge/internal/wire"
	"gvisor.dev/gvisor/pkg/tcpip"
	"gvisor.dev/gvisor/pkg/tcpip/adapters/gonet"
	"gvisor.dev/gvisor/pkg/tcpip/network/ipv6"
)

type MediaFrame struct {
	JPEG       []byte
	RGBA       []byte
	Width      int
	Height     int
	DisplayID  uint64
	Rotation   int
	CapturedAt time.Time
}
type OCRBox struct {
	Text                string
	X, Y, Width, Height float64
	Confidence          float64
}
type VisionOCRFunc func(context.Context, MediaFrame) ([]OCRBox, error)
type DisplayStateEvent = wire.DisplayStateEvent
type MediaPipelineConfig struct {
	StreamID    string
	DisplayID   uint64
	Rotation    int
	MaxLongSide int
	MaxFPS      int
	SocketPath  string
	OnState     func(DisplayStateEvent)
}
type MediaPipeline interface {
	Start(context.Context) (string, error)
	ApplyDemand(maxLongSide, maxFPS *int, active *bool)
	RequestKeyframe()
	LatestFrame(maxAge time.Duration) (*MediaFrame, bool)
	SetPrivacyHidden(state, reason string)
	ResumeVisible(displayID uint64, rotation int)
	Stop(context.Context) error
}

// The factory's context owns the display XPC and UDP transports until Stop completes.
type MediaPipelineFactory func(context.Context, *Session, MediaPipelineConfig) (MediaPipeline, error)

type MediaUDPTransport interface {
	ListenUDP(uint16) (net.PacketConn, error)
	LocalIP() net.IP
	RemoteIP() net.IP
}
type mediaUDP struct {
	ctx     context.Context
	session *Session
}

func (s *Session) MediaUDP(ctx context.Context) MediaUDPTransport {
	return mediaUDP{ctx: ctx, session: s}
}
func (t mediaUDP) LocalIP() net.IP  { return t.session.tunnel.LocalIP }
func (t mediaUDP) RemoteIP() net.IP { return t.session.tunnel.RemoteIP }
func (t mediaUDP) ListenUDP(port uint16) (net.PacketConn, error) {
	if err := t.ctx.Err(); err != nil {
		return nil, err
	}
	if port == 0 {
		return t.session.tunnel.ListenUDP(t.ctx)
	}
	socket, err := gonet.DialUDP(t.session.tunnel.Stack, &tcpip.FullAddress{NIC: 1, Addr: tcpip.AddrFromSlice(t.LocalIP().To16()), Port: port}, nil, ipv6.ProtocolNumber)
	if err != nil {
		return nil, err
	}
	context.AfterFunc(t.ctx, func() { _ = socket.Close() })
	return socket, nil
}

// SetDisplayBackend attaches the media adapter and OCR implementation at bridge startup.
func (m *Manager) SetDisplayBackend(factory MediaPipelineFactory, ocr VisionOCRFunc, publish func(wire.DisplayStateEvent)) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.mediaFactory, m.visionOCR, m.publishDisplay = factory, ocr, publish
}

type displaySession struct {
	ref               wire.DisplayRef
	pipeline          MediaPipeline
	config            MediaPipelineConfig
	demandMu          sync.Mutex
	life              context.Context
	cancel            context.CancelFunc
	monitorDone       chan struct{}
	cancelMonitor     context.CancelFunc
	stopRoute         func() bool
	stopOnce          sync.Once
	stopErr           error
	hidden, reason    string
	powerPending      bool
	powerPendingUntil time.Time
	ending            bool
	visibleAfter      time.Time
	displayID         uint64
	rotation          int
	generation        uint64
}

func (s *screenSession) startDisplay(ctx context.Context, p *wire.DisplayStartParams, native *Session, route context.Context, root string, factory MediaPipelineFactory, publish func(wire.DisplayStateEvent), guard, fence func() error) (wire.DisplayStartResult, error) {
	if factory == nil {
		return wire.DisplayStartResult{}, wire.Fail(wire.Unsupported)
	}
	s.displayMu.Lock()
	busy := s.display != nil
	s.displayMu.Unlock()
	if busy {
		return wire.DisplayStartResult{}, wire.Fail(wire.PhoneInUse)
	}
	state, err := s.backend.State(ctx)
	if err != nil {
		return wire.DisplayStartResult{}, err
	}
	foreground, foregroundKnown := s.foregroundChecked(ctx)
	rotation := 0
	if state.Rotation != nil {
		rotation = *state.Rotation
	}
	if err := guard(); err != nil {
		return wire.DisplayStartResult{}, err
	}
	// Short, unique names also leave room for Darwin's Unix socket path limit.
	path := filepath.Join(root, "m-"+uuid.New().String()[:12]+".sock")
	life, cancel := context.WithCancel(context.WithoutCancel(ctx))
	d := &displaySession{ref: p.DisplayRef, life: life, cancel: cancel, displayID: state.DisplayID, rotation: rotation, generation: 1, visibleAfter: time.Now()}
	d.config = MediaPipelineConfig{
		StreamID: p.StreamID, DisplayID: state.DisplayID, Rotation: rotation, MaxLongSide: p.MaxLongSide, MaxFPS: p.MaxFPS,
		SocketPath: path, OnState: func(event DisplayStateEvent) {
			if event.StreamID == p.StreamID {
				if event.Generation > 0 {
					s.displayMu.Lock()
					if event.Generation > d.generation {
						d.generation = event.Generation
					}
					s.displayMu.Unlock()
				}
				if publish != nil {
					publish(event)
				}
			}
		},
	}
	stopSetup := context.AfterFunc(ctx, cancel)
	defer stopSetup()
	d.pipeline, err = factory(life, native, d.config)
	if err != nil || d.pipeline == nil {
		cancel()
		return wire.DisplayStartResult{}, wire.Fail(wire.NativeServiceFailed)
	}
	started := false
	defer func() {
		if !started {
			_ = d.stop()
		}
	}()
	if state, reason := displayPrivacy(state, foreground, foregroundKnown); state != "" {
		d.hide(state, reason)
	}
	sock, err := d.pipeline.Start(ctx)
	if err != nil {
		return wire.DisplayStartResult{}, wire.Fail(wire.NativeServiceFailed)
	}
	if d.hidden != "" {
		// Start can publish a starting event even when RTP negotiation is suspended.
		d.pipeline.SetPrivacyHidden(d.hidden, d.reason)
	}
	info, err := os.Lstat(path)
	if sock != path || err != nil || info.Mode().Type() != os.ModeSocket || info.Mode().Perm() != 0600 {
		return wire.DisplayStartResult{}, wire.Fail(wire.NativeServiceFailed)
	}
	sample := s.privacySample()
	state, err = s.backend.State(ctx)
	if err != nil {
		return wire.DisplayStartResult{}, err
	}
	foreground, foregroundKnown = s.foregroundChecked(ctx)
	if err := guard(); err != nil {
		return wire.DisplayStartResult{}, err
	}
	if !stopSetup() || life.Err() != nil || ctx.Err() != nil {
		return wire.DisplayStartResult{}, wire.Fail(wire.Cancelled)
	}
	monitorCtx, cancelMonitor := context.WithCancel(d.life)
	d.cancelMonitor = cancelMonitor
	d.monitorDone = make(chan struct{})
	s.displayMu.Lock()
	s.display = d
	if route != nil {
		d.stopRoute = context.AfterFunc(route, func() {
			s.displayMu.Lock()
			defer s.displayMu.Unlock()
			if s.display == d {
				d.ending = true
				s.privacyRevision++
				d.hide("protected", "session-ended")
				if s.ownerBatchCancel != nil {
					s.ownerBatchCancel()
				}
			}
		})
	}
	s.displayMu.Unlock()
	s.applyPrivacySample(state, foreground, foregroundKnown, &sample)
	go s.monitorDisplay(monitorCtx, d, fence)
	started = true
	return wire.DisplayStartResult{SocketPath: sock}, nil
}

func (d *displaySession) stop() error {
	d.stopOnce.Do(func() {
		if d.stopRoute != nil {
			d.stopRoute()
		}
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		d.pipeline.SetPrivacyHidden("protected", "session-ended")
		d.stopErr = d.pipeline.Stop(ctx)
		d.cancel()
		_ = os.Remove(d.config.SocketPath)
	})
	return d.stopErr
}

func (s *screenSession) stopDisplay(ref *wire.DisplayRef) error {
	s.displayMu.Lock()
	d := s.display
	if d == nil || (ref != nil && d.ref != *ref) {
		s.displayMu.Unlock()
		return nil
	}
	d.pipeline.SetPrivacyHidden("protected", "session-ended")
	s.display = nil
	s.displayMu.Unlock()
	if d.monitorDone != nil {
		// Stop the monitor without canceling the transport needed by the final Stream Stop.
		d.cancelMonitor()
		<-d.monitorDone
	}
	_ = s.resetOwnerInput()
	return d.stop()
}

func (s *screenSession) monitorDisplay(life context.Context, d *displaySession, guard func() error) {
	defer close(d.monitorDone)
	ticker := time.NewTicker(200 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-life.Done():
			return
		case <-ticker.C:
		}
		s.displayMu.Lock()
		active := s.display == d
		s.displayMu.Unlock()
		if !active {
			return
		}
		if err := guard(); err != nil {
			s.hideDisplay("protected", "session-ended")
			return
		}
		s.displayMu.Lock()
		sample := s.privacyRevision
		s.displayMu.Unlock()
		ctx, cancel := context.WithTimeout(life, 2*time.Second)
		state, err := s.backend.State(ctx)
		var f *Foreground
		fgKnown := false
		if err == nil && state.screenBlocker() == "" {
			var foregroundErr error
			f, foregroundErr = s.backend.Foreground(ctx)
			fgKnown = foregroundErr == nil
			// Leave state intact when foreground fails: displayPrivacy still fails
			// closed via !fgKnown ("target-unavailable") without misreporting
			// an awake, unlocked phone as "locked-screen".
		}
		cancel()
		if err != nil {
			state = unknownState()
		}
		if life.Err() == nil {
			s.applyPrivacySample(state, f, fgKnown, &sample)
		}
	}
}

func (s *screenSession) hideDisplay(state, reason string) {
	s.displayMu.Lock()
	d := s.display
	s.privacyRevision++
	if d != nil {
		d.hide(state, reason)
	}
	s.displayMu.Unlock()
	s.invalidateObservation()
	_ = s.resetOwnerInput()
}
func (d *displaySession) hide(state, reason string) {
	if d.hidden != state || d.reason != reason {
		d.hidden, d.reason = state, reason
		d.pipeline.SetPrivacyHidden(state, reason)
	}
}
func (s *screenSession) invalidateObservation() {
	s.mu.Lock()
	s.observation = nil
	s.mu.Unlock()
}
func (s *screenSession) privacySample() uint64 {
	s.displayMu.Lock()
	defer s.displayMu.Unlock()
	return s.privacyRevision
}
func (s *screenSession) applyPrivacy(state DeviceState, foreground *Foreground, foregroundKnown bool) {
	s.applyPrivacySample(state, foreground, foregroundKnown, nil)
}
func (s *screenSession) applyPrivacySample(state DeviceState, foreground *Foreground, foregroundKnown bool, revision *uint64) {
	s.displayMu.Lock()
	d := s.display
	if d == nil {
		s.displayMu.Unlock()
		if state.screenBlocker() != "" || (foreground != nil && foreground.AppID == opensteerAppID) {
			s.invalidateObservation()
		}
		return
	}
	stale := revision != nil && *revision != s.privacyRevision
	if state.Display == "off" || state.Lock == "locked" || (!d.powerPendingUntil.IsZero() && time.Now().After(d.powerPendingUntil)) {
		d.powerPending = false
		d.powerPendingUntil = time.Time{}
	}
	hidden, reason := displayPrivacy(state, foreground, foregroundKnown)
	if d.ending {
		hidden, reason = "protected", "session-ended"
	} else if d.powerPending {
		hidden, reason = "protected", "locked-screen"
	}
	private := hidden != ""
	// A stale sample may still fail closed (apply a shield), but must never
	// lift a newer privacy shield or overwrite a newer revision's visible state.
	if stale && !private {
		s.displayMu.Unlock()
		return
	}
	s.privacyRevision++
	if private {
		d.hide(hidden, reason)
	} else {
		changed := d.displayID != state.DisplayID || d.rotation != *state.Rotation
		if changed {
			d.hide("protected", "target-unavailable")
		}
		if d.hidden != "" {
			d.visibleAfter = time.Now()
			d.hidden, d.reason = "", ""
			d.displayID, d.rotation = state.DisplayID, *state.Rotation
			d.pipeline.ResumeVisible(d.displayID, d.rotation)
		}
		private = changed
	}
	s.displayMu.Unlock()
	if private {
		s.invalidateObservation()
		_ = s.resetOwnerInput()
	}
}

func displayPrivacy(state DeviceState, foreground *Foreground, foregroundKnown bool) (string, string) {
	switch {
	case state.Display == "off":
		return "screen-off", "locked-screen"
	case state.Lock == "locked":
		return "protected", "locked-screen"
	case state.Lock != "unlocked" || state.Display != "on" || state.Rotation == nil:
		return "protected", "target-unavailable"
	case foreground != nil && foreground.AppID == opensteerAppID:
		return "protected", "opensteer-app"
	case !foregroundKnown:
		return "protected", "target-unavailable"
	}
	return "", ""
}

func (s *screenSession) displayFrame(epoch uint64, state DeviceState) (*MediaFrame, bool) {
	s.displayMu.Lock()
	defer s.displayMu.Unlock()
	d := s.display
	if d == nil || d.ref.NativeEpoch != epoch || d.hidden != "" || state.Rotation == nil {
		return nil, false
	}
	frame, ok := d.pipeline.LatestFrame(250 * time.Millisecond)
	return frame, ok && frame != nil && frame.DisplayID == state.DisplayID && frame.Rotation == *state.Rotation &&
		!frame.CapturedAt.Before(d.visibleAfter) && time.Since(frame.CapturedAt) <= 250*time.Millisecond &&
		frame.Width >= 2 && frame.Height >= 2 && frame.Width <= 4096 && frame.Height <= 4096
}

func (s *screenSession) mediaFrameStillVisible(epoch uint64, frame *MediaFrame) bool {
	s.displayMu.Lock()
	defer s.displayMu.Unlock()
	d := s.display
	return d != nil && d.ref.NativeEpoch == epoch && d.hidden == "" &&
		d.displayID == frame.DisplayID && d.rotation == frame.Rotation && !frame.CapturedAt.Before(d.visibleAfter)
}

func (s *screenSession) setPower(ctx context.Context, state DeviceState, action string, guard func() error, wait pause) error {
	switch action {
	case "wake":
		if state.Display == "on" {
			return nil
		}
		if state.Display != "off" {
			return wire.Fail(wire.DisplayUnknown)
		}
	case "lock":
		if state.Display == "off" || state.Lock == "locked" {
			return nil
		}
		if err := state.safe(); err != nil {
			return err
		}
		s.displayMu.Lock()
		if d := s.display; d != nil {
			d.powerPending = true
			d.powerPendingUntil = time.Now().Add(2 * time.Second)
		}
		s.displayMu.Unlock()
		s.hideDisplay("protected", "locked-screen")
	}
	if err := s.withInput(ctx, func(c xpcChannel) error { return pressButton(ctx, c, "lock", guard, wait) }); err != nil {
		if action == "lock" && Classify(err, wire.NativeServiceFailed).Effect == "not-started" {
			s.displayMu.Lock()
			if d := s.display; d != nil {
				d.powerPending = false
				d.powerPendingUntil = time.Time{}
			}
			s.displayMu.Unlock()
			sample := s.privacySample()
			if fresh, stateErr := s.backend.State(ctx); stateErr == nil {
				f, fgKnown := s.foregroundChecked(ctx)
				s.applyPrivacySample(fresh, f, fgKnown, &sample)
			}
		}
		return err
	}
	if action == "lock" {
		return nil
	}
	s.displayMu.Lock()
	if d := s.display; d != nil {
		d.powerPending = false
		d.powerPendingUntil = time.Time{}
	}
	s.displayMu.Unlock()
	for i := 0; i < 5; i++ {
		sample := s.privacySample()
		state, err := s.backend.State(ctx)
		if err == nil && state.Display == "on" {
			f, fgKnown := s.foregroundChecked(ctx)
			s.applyPrivacySample(state, f, fgKnown, &sample)
			return nil
		}
		if err := wait(ctx, 100*time.Millisecond); err != nil {
			return submittedError(err)
		}
	}
	return &wire.Failure{Code: wire.WakeRequired, Effect: "submitted"}
}

func refusal(err error, power bool) wire.DisplayInputResult {
	if err == nil {
		return wire.DisplayInputResult{Outcome: "dispatched"}
	}
	result := wire.DisplayInputResult{Outcome: "refused", Reason: "unavailable"}
	if errors.Is(err, errSensitive) {
		result.Reason = "sensitive"
		return result
	}
	if errors.Is(err, errNoField) {
		result.Reason = "no-field"
		return result
	}
	switch Classify(err, wire.NativeServiceFailed).Code {
	case wire.StaleEpoch, wire.StaleObservation, wire.NoSession:
		result.Reason = "stale"
		if !power {
			result.Outcome = "stale"
		}
	case wire.Unsupported, wire.UnsupportedText:
		result.Reason = "unsupported"
	case wire.NativeLimit:
		result.Reason = "too-large"
	case wire.PhoneInUse:
		result.Reason = "contended"
	}
	return result
}
