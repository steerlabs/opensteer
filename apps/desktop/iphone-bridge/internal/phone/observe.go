package phone

import (
	"context"
	"encoding/base64"
	"sync"
	"time"

	"github.com/danielpaulus/go-ios/ios/coredevice"
	"github.com/google/uuid"
	"github.com/steerlabs/opensteer/iphone-bridge/internal/wire"
)

type screenBackend interface {
	State(context.Context) (DeviceState, error)
	Capture(context.Context, string) ([]byte, error)
	AX(context.Context) (AXSnapshot, error)
	HID(context.Context) (xpcChannel, error)
	Launch(context.Context, string, func() error) error
}
type nativeScreen struct {
	open channelOpener
	dial ServiceDialer
	lock func(context.Context) string
}

func (n nativeScreen) State(ctx context.Context) (DeviceState, error) {
	return readDeviceState(ctx, n.open, n.lock)
}
func (n nativeScreen) Capture(ctx context.Context, display string) ([]byte, error) {
	input := map[string]interface{}{"requestedFormat": "png"}
	if display != "" {
		input["displayUniqueID"] = display
	}
	out, err := exchange(ctx, n.open, "com.apple.coredevice.screencaptureservice", coredevice.BuildRequestWithAction(uuid.New().String(), "com.apple.coredevice.feature.capturescreenshot", "com.apple.coredevice.action.capturescreenshot", input), nil, false)
	if err != nil {
		return nil, err
	}
	data, ok := out["image"].([]byte)
	if !ok || len(data) == 0 || len(data) > 32<<20 {
		return nil, wire.Fail(wire.NativeLimit)
	}
	return data, nil
}
func (n nativeScreen) AX(ctx context.Context) (AXSnapshot, error) {
	return collectRemoteAX(ctx, n.dial)
}
func (n nativeScreen) HID(ctx context.Context) (xpcChannel, error) {
	return n.open(ctx, "com.apple.coredevice.hid.indigo")
}
func (n nativeScreen) Launch(ctx context.Context, id string, before func() error) error {
	return launchApp(ctx, n.open, id, before)
}

type screenSession struct {
	mu          sync.Mutex
	backend     screenBackend
	observation *Observation
	revision    uint64
	cancel      context.CancelFunc
	done        chan struct{}
	closed      bool
	apps        map[string]bool
}
type Observation struct {
	ObservationToken string      `json:"observationToken"`
	NativeEpoch      uint64      `json:"nativeEpoch"`
	GeometryRevision uint64      `json:"geometryRevision"`
	Geometry         Geometry    `json:"geometry"`
	State            DeviceState `json:"state"`
	Nodes            []AXNode    `json:"nodes"`
	Coverage         AXCoverage  `json:"coverage"`
	Foreground       *Foreground `json:"foreground"`
	Buttons          []string    `json:"buttons"`
	TextReason       wire.Reason `json:"textReason"`
	ClearReason      wire.Reason `json:"clearReason"`
	Screenshot       *Screenshot `json:"screenshot"`
}
type Screenshot struct {
	MimeType string `json:"mimeType"`
	Base64   string `json:"base64"`
	Width    int    `json:"width"`
	Height   int    `json:"height"`
}
type Foreground struct {
	AppID string `json:"appId"`
	Label string `json:"label"`
}

func (s *Session) screenState() *screenSession {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.screen == nil {
		s.screen = &screenSession{backend: nativeScreen{open: func(ctx context.Context, name string) (xpcChannel, error) { return s.OpenXPC(ctx, name) }, dial: s, lock: s.readLockState}, apps: map[string]bool{}, closed: s.closed}
	}
	return s.screen
}
func (s *screenSession) begin(ctx context.Context) (context.Context, func(), error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed || s.done != nil {
		return nil, nil, wire.Fail(wire.NoSession)
	}
	ctx, cancel := context.WithCancel(ctx)
	s.cancel = cancel
	s.done = make(chan struct{})
	return ctx, func() {
		cancel()
		s.mu.Lock()
		close(s.done)
		s.done = nil
		s.cancel = nil
		s.mu.Unlock()
	}, nil
}
func (s *screenSession) close() {
	s.mu.Lock()
	s.closed = true
	s.observation = nil
	abort, done := s.cancel, s.done
	s.mu.Unlock()
	if abort != nil {
		abort()
	}
	if done != nil {
		<-done
	}
}
func (s *screenSession) observe(ctx context.Context, p *wire.ObserveParams, guard func() error) (interface{}, error) {
	ctx, finish, err := s.begin(ctx)
	if err != nil {
		return nil, err
	}
	defer finish()
	s.mu.Lock()
	s.observation = nil
	s.mu.Unlock()
	before, err := s.backend.State(ctx)
	if err != nil {
		return nil, err
	}
	if err = before.safe(); err != nil {
		return nil, err
	}
	png, err := s.backend.Capture(ctx, before.uniqueID)
	if err != nil {
		return nil, err
	}
	jpeg, g, err := encodeScreenshot(png)
	if err != nil {
		return nil, err
	}
	g.DisplayID = before.DisplayID
	g.DisplayUniqueID = before.uniqueID
	g.Rotation = before.Rotation
	axCtx, cancel := context.WithTimeout(ctx, 8*time.Second)
	ax, axErr := s.backend.AX(axCtx)
	cancel()
	if ctx.Err() != nil {
		return nil, Classify(ctx.Err(), wire.Cancelled)
	}
	if axErr != nil {
		ax = AXSnapshot{Nodes: []AXNode{}, Coverage: AXCoverage{CoordinateSpace: "unqualified", Status: "unavailable", Reason: "accessibility-unavailable"}}
	}
	after, err := s.backend.State(ctx)
	if err != nil {
		return nil, err
	}
	if !before.same(after) {
		return nil, wire.Fail(wire.StaleObservation)
	}
	if err := guard(); err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed || ctx.Err() != nil {
		return nil, wire.Fail(wire.NoSession)
	}
	s.revision++
	o := &Observation{ObservationToken: uuid.New().String(), NativeEpoch: p.NativeEpoch, GeometryRevision: s.revision, Geometry: g, State: before, Nodes: ax.Nodes, Coverage: ax.Coverage, Foreground: ax.Foreground, Buttons: []string{"home", "lock", "volumeUp", "volumeDown"}, TextReason: wire.UnsupportedText, ClearReason: wire.UnsupportedClear}
	if *p.IncludeScreenshot {
		o.Screenshot = &Screenshot{MimeType: "image/jpeg", Base64: base64.StdEncoding.EncodeToString(jpeg), Width: g.Width, Height: g.Height}
	}
	s.observation = o
	return o, nil
}
