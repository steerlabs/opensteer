package phone

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/danielpaulus/go-ios/ios/coredevice"
	"github.com/google/uuid"
	"github.com/steerlabs/opensteer/iphone-bridge/internal/wire"
)

type screenBackend interface {
	State(context.Context) (DeviceState, error)
	Capture(context.Context, string) ([]byte, error)
	Foreground(context.Context) (*Foreground, error)
	AX(context.Context) (AXSnapshot, error)
	HID(context.Context) (xpcChannel, error)
	Launch(context.Context, string, func() error) error
}
type nativeScreen struct {
	open channelOpener
	dial ServiceDialer
	lock func(context.Context) string
	apps *appCache
}

// appCache keeps the installed-app list for front-app labels; it rarely
// changes, and reading it costs about half a second per call.
type appCache struct {
	mu   sync.Mutex
	apps []InstalledApp
	at   time.Time
}

func (c *appCache) read(ctx context.Context, dial ServiceDialer) ([]InstalledApp, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.apps != nil && time.Since(c.at) < time.Minute {
		return c.apps, nil
	}
	apps, err := readInstalledApps(ctx, dial)
	if err != nil {
		return nil, err
	}
	c.apps, c.at = apps, time.Now()
	return apps, nil
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
func (n nativeScreen) Foreground(ctx context.Context) (*Foreground, error) {
	return readForeground(ctx, n.dial, n.apps.read)
}
func (n nativeScreen) AX(ctx context.Context) (AXSnapshot, error) {
	return collectRemoteAX(ctx, n.dial)
}
func (n nativeScreen) HID(ctx context.Context) (xpcChannel, error) {
	if s, ok := n.dial.(*Session); ok {
		c, raw, err := s.openXPC(ctx, hidService)
		if err != nil {
			return nil, err
		}
		return boundedHID{xpcChannel: c, deadline: raw.SetDeadline}, nil
	}
	return n.open(ctx, hidService)
}
func (n nativeScreen) Launch(ctx context.Context, id string, before func() error) error {
	return launchApp(ctx, n.open, id, before)
}

func (n nativeScreen) AXForDisplay(ctx context.Context, state DeviceState) (AXSnapshot, error) {
	if native, ok := n.dial.(*Session); !ok || servicePresent(native, deviceHubAXService) {
		if snapshot, err := collectHubAX(ctx, n.dial, state.viewport, state.DisplayID); err == nil && len(snapshot.Nodes) > 0 {
			return snapshot, nil
		}
	}
	return n.AX(ctx)
}
func (n nativeScreen) Focus(ctx context.Context) (focusedField, error) {
	if native, ok := n.dial.(*Session); ok && !servicePresent(native, deviceHubAXService) {
		return focusedField{}, wire.Fail(wire.UnsupportedText)
	}
	state, err := n.State(ctx)
	if err != nil {
		return focusedField{}, Classify(err, wire.NativeServiceFailed)
	}
	if err := state.safe(); err != nil {
		return focusedField{}, err
	}
	foreground, err := n.Foreground(ctx)
	if err != nil {
		return focusedField{}, Classify(err, wire.NativeServiceFailed)
	}
	if foreground != nil && foreground.AppID == opensteerAppID {
		return focusedField{}, errSensitive
	}
	focus, err := readHubFocus(ctx, n.dial, state.viewport, state.DisplayID)
	if err != nil {
		if errors.Is(err, errNoField) {
			return focusedField{}, errNoField
		}
		return focusedField{}, Classify(err, wire.AccessibilityUnavailable)
	}
	if focus.Secure == "yes" {
		return focusedField{}, errSensitive
	}
	if focus.Secure != "no" {
		return focusedField{}, wire.Fail(wire.AccessibilityUnavailable)
	}
	return focus, nil
}
func (n nativeScreen) Pasteboard() phonePasteboard { return pasteboard{open: n.open} }
func (n nativeScreen) Terminate(ctx context.Context, id string, check func() error) error {
	apps, err := n.apps.read(ctx, n.dial)
	if err != nil {
		return err
	}
	return terminateApp(ctx, n.open, n.dial, apps, id, check)
}
func (n nativeScreen) editingReasons() (*wire.Reason, *wire.Reason) {
	if s, ok := n.dial.(*Session); ok {
		if !servicePresent(s, hidService) || !servicePresent(s, deviceHubAXService) {
			return reasonPointer(wire.UnsupportedText), reasonPointer(wire.UnsupportedClear)
		}
		if !servicePresent(s, pasteboardService) {
			return reasonPointer(wire.UnsupportedText), nil
		}
	}
	return nil, nil
}

type screenSession struct {
	privacyRevision  uint64
	ownerBatchCancel context.CancelFunc
	mu               sync.Mutex
	backend          screenBackend
	observation      *Observation
	wakeRef          *wire.PerformParams
	revision         uint64
	cancel           context.CancelFunc
	done             chan struct{}
	closed           bool
	apps             map[string]bool
	inputMu          sync.Mutex
	input            *gracefulInput
	cancelInput      context.CancelFunc
	ownerContact     *ownerContact
	ownerKeys        []ownerKey
	displayMu        sync.Mutex
	display          *displaySession
	visionOCR        VisionOCRFunc
}
type Observation struct {
	ObservationToken string       `json:"observationToken"`
	NativeEpoch      uint64       `json:"nativeEpoch"`
	GeometryRevision uint64       `json:"geometryRevision"`
	Geometry         Geometry     `json:"geometry"`
	State            DeviceState  `json:"state"`
	Nodes            []AXNode     `json:"nodes"`
	Coverage         AXCoverage   `json:"coverage"`
	Foreground       *Foreground  `json:"foreground"`
	Buttons          []string     `json:"buttons"`
	TextReason       *wire.Reason `json:"textReason"`
	ClearReason      *wire.Reason `json:"clearReason"`
	Screenshot       *Screenshot  `json:"screenshot"`
}

// ScreenStatus is a state-only observation. It contains no capture, app identity,
// or geometry credential. When the display is off, it may carry a wake-only token
// that perform accepts exclusively for a single wake action.
type ScreenStatus struct {
	NativeEpoch      uint64      `json:"nativeEpoch"`
	State            DeviceState `json:"state"`
	Reason           wire.Reason `json:"reason"`
	WakeToken        string      `json:"wakeToken,omitempty"`
	GeometryRevision uint64      `json:"geometryRevision,omitempty"`
}

func (s *screenSession) screenStatus(p *wire.ObserveParams, state DeviceState, reason wire.Reason) *ScreenStatus {
	status := &ScreenStatus{NativeEpoch: p.NativeEpoch, State: state, Reason: reason}
	s.mu.Lock()
	defer s.mu.Unlock()
	if state.Display == "off" && !s.closed {
		s.revision++
		token := uuid.New().String()
		status.WakeToken = token
		status.GeometryRevision = s.revision
		s.wakeRef = &wire.PerformParams{ScreenRef: p.ScreenRef, ObservationToken: token, GeometryRevision: s.revision}
	} else {
		s.wakeRef = nil
	}
	return status
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
		s.screen = &screenSession{backend: nativeScreen{open: func(ctx context.Context, name string) (xpcChannel, error) { return s.OpenXPC(ctx, name) }, dial: s, lock: s.readLockState, apps: &appCache{}}, apps: map[string]bool{}, closed: s.closed, visionOCR: s.visionOCR}
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

// closeAgent ends an agent control/observe session without tearing down an
// independently attached owner Live View display stream or owner input state.
func (s *screenSession) closeAgent() {
	s.mu.Lock()
	s.observation = nil
	s.wakeRef = nil
	s.apps = map[string]bool{}
	abort, done := s.cancel, s.done
	s.mu.Unlock()
	if abort != nil {
		abort()
	}
	if done != nil {
		<-done
	}
}
func (s *screenSession) close() {
	s.mu.Lock()
	s.closed = true
	s.observation = nil
	s.wakeRef = nil
	abort, done := s.cancel, s.done
	s.mu.Unlock()
	if abort != nil {
		abort()
	}
	s.displayMu.Lock()
	if s.display != nil {
		s.privacyRevision++
		s.display.ending = true
		s.display.hide("protected", "session-ended")
		if s.display.cancelMonitor != nil {
			s.display.cancelMonitor()
		}
	}
	s.displayMu.Unlock()
	if done != nil {
		<-done
	}
	_ = s.stopDisplay(nil)
	s.closeInput()
}

// foregroundChecked reads the front app and reports whether the lookup itself succeeded.
// Privacy callers fail closed when known is false so a failed lookup cannot lift a shield.
func (s *screenSession) foregroundChecked(ctx context.Context) (*Foreground, bool) {
	f, err := s.backend.Foreground(ctx)
	if err != nil {
		slog.Debug("bridge.native-error", "reason", string(Classify(err, wire.NativeServiceFailed).Code))
		return nil, false
	}
	return f, true
}

// settleForeground keeps Opensteer's own screen private if any reading saw it.
// Otherwise it names an app only when the readings before and after the capture
// both exist and agree; accessibility is a fallback when neither exists.
func settleForeground(first, last, ax *Foreground) *Foreground {
	for _, f := range []*Foreground{first, last, ax} {
		if f != nil && f.AppID == opensteerAppID {
			return f
		}
	}
	if first == nil && last == nil {
		return ax
	}
	if first != nil && last != nil && first.AppID == last.AppID {
		return first
	}
	return nil
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
		s.hideDisplay("protected", "target-unavailable")
		return nil, err
	}
	if reason := before.screenBlocker(); reason != "" {
		s.applyPrivacy(before, nil, false)
		if err := guard(); err != nil {
			return nil, err
		}
		return s.screenStatus(p, before, reason), nil
	}
	first, firstKnown := s.foregroundChecked(ctx)
	s.applyPrivacy(before, first, firstKnown)
	private := first != nil && first.AppID == opensteerAppID
	var jpegData []byte
	var g Geometry
	var frame *MediaFrame
	if !private {
		if latest, ok := s.displayFrame(p.NativeEpoch, before); ok {
			frame = latest
			jpegData, g, err = encodeMediaScreenshot(latest)
			if err != nil {
				frame = nil
			}
		}
		if frame == nil {
			png, e := s.backend.Capture(ctx, before.uniqueID)
			if e != nil {
				return nil, e
			}
			jpegData, g, err = encodeScreenshot(png)
			if err != nil {
				return nil, err
			}
		}
	}
	g.DisplayID, g.DisplayUniqueID, g.Rotation = before.DisplayID, before.uniqueID, before.Rotation
	last := first
	ax := unavailableAX()
	if !private {
		var lastKnown bool
		last, lastKnown = s.foregroundChecked(ctx)
		if last != nil && last.AppID == opensteerAppID {
			s.applyPrivacy(before, last, lastKnown)
		} else {
			axCtx, cancel := context.WithTimeout(ctx, 8*time.Second)
			var snapshot AXSnapshot
			var axErr error
			if backend, ok := s.backend.(interface {
				AXForDisplay(context.Context, DeviceState) (AXSnapshot, error)
			}); ok {
				snapshot, axErr = backend.AXForDisplay(axCtx, before)
			} else {
				snapshot, axErr = s.backend.AX(axCtx)
			}
			cancel()
			if axErr == nil {
				ax = snapshot
			}
		}
	}
	foreground := settleForeground(first, last, ax.Foreground)
	private = foreground != nil && foreground.AppID == opensteerAppID
	if private {
		s.applyPrivacy(before, foreground, true)
		ax = unavailableAX()
		if g.Width == 0 {
			// Private observations retain only the minimum valid geometry.
			g.Width, g.Height, g.CaptureWidth, g.CaptureHeight = 2, 2, 2, 2
		}
	} else {
		if foreground != nil && ax.Foreground != nil && foreground.AppID != ax.Foreground.AppID {
			ax = unavailableAX()
		}
		if first != nil && last != nil && first.AppID != last.AppID {
			return nil, wire.Fail(wire.StaleObservation)
		}
		qualifyAX(&ax, before, g)
		if s.visionOCR != nil && g.Rotation != nil {
			ocrFrame := frame
			if ocrFrame == nil {
				ocrFrame = &MediaFrame{JPEG: jpegData, Width: g.Width, Height: g.Height, DisplayID: g.DisplayID, Rotation: *g.Rotation}
			}
			ocrCtx, cancel := context.WithTimeout(ctx, time.Second)
			boxes, e := s.visionOCR(ocrCtx, *ocrFrame)
			cancel()
			if e == nil {
				fuseOCR(&ax, boxes, g, ocrFrame.Width, ocrFrame.Height)
			}
		}
	}
	after, err := s.backend.State(ctx)
	if err != nil {
		s.hideDisplay("protected", "target-unavailable")
		return nil, err
	}
	finalKnown := private
	if !private {
		var final *Foreground
		final, finalKnown = s.foregroundChecked(ctx)
		if final != nil && final.AppID == opensteerAppID {
			foreground, private, ax, finalKnown = final, true, unavailableAX(), true
		} else if final != nil && foreground != nil && final.AppID != foreground.AppID {
			s.applyPrivacy(after, final, finalKnown)
			return nil, wire.Fail(wire.StaleObservation)
		}
	}
	s.applyPrivacy(after, foreground, finalKnown)
	if err := guard(); err != nil {
		return nil, err
	}
	if reason := after.screenBlocker(); reason != "" {
		return s.screenStatus(p, after, reason), nil
	}
	if !before.same(after) || (!private && frame != nil && !s.mediaFrameStillVisible(p.NativeEpoch, frame)) {
		return nil, wire.Fail(wire.StaleObservation)
	}
	limitAX(&ax)
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed || ctx.Err() != nil {
		return nil, wire.Fail(wire.NoSession)
	}
	s.revision++
	o := &Observation{ObservationToken: uuid.New().String(), NativeEpoch: p.NativeEpoch, GeometryRevision: s.revision, Geometry: g, State: before, Nodes: ax.Nodes, Coverage: ax.Coverage, Foreground: foreground, Buttons: []string{"home", "lock", "volumeUp", "volumeDown", "recents", "notifications", "quickSettings", "action", "siri"}, TextReason: reasonPointer(wire.UnsupportedText), ClearReason: reasonPointer(wire.UnsupportedClear)}
	if backend, ok := s.backend.(interface {
		editingReasons() (*wire.Reason, *wire.Reason)
	}); ok && !private {
		o.TextReason, o.ClearReason = backend.editingReasons()
	}
	if private {
		o.Buttons = []string{}
	}
	if *p.IncludeScreenshot && !private {
		o.Screenshot = &Screenshot{MimeType: "image/jpeg", Base64: base64.StdEncoding.EncodeToString(jpegData), Width: g.Width, Height: g.Height}
	}
	if !private {
		s.observation = o
		s.wakeRef = &wire.PerformParams{ScreenRef: p.ScreenRef, ObservationToken: o.ObservationToken, GeometryRevision: o.GeometryRevision}
	} else {
		s.wakeRef = nil
	}
	return o, nil
}

func unavailableAX() AXSnapshot {
	return AXSnapshot{Nodes: []AXNode{}, Coverage: AXCoverage{CoordinateSpace: "unqualified", Status: "unavailable", Reason: "accessibility-unavailable"}}
}

func qualifyAX(snapshot *AXSnapshot, state DeviceState, g Geometry) {
	if !snapshot.viewportFrames || g.Rotation == nil || state.viewport.Width <= 0 || state.viewport.Height <= 0 {
		return
	}
	viewport := state.viewport
	width, height := viewport.Width, viewport.Height
	if *g.Rotation == 90 || *g.Rotation == 270 {
		width, height = height, width
	}
	if !matchingAspect(width, height, float64(g.CaptureWidth), float64(g.CaptureHeight)) {
		return
	}
	// The native AX frames are logical portrait-space coordinates.
	inverse := map[int]affine{0: {A: 1, D: 1}, 90: {B: 1, C: -1, TX: 1}, 180: {A: -1, D: -1, TX: 1, TY: 1}, 270: {B: -1, C: 1, TY: 1}}[*g.Rotation]
	snapshot.Coverage.MissingFrames = 0
	for i := range snapshot.Nodes {
		node := &snapshot.Nodes[i]
		if f := node.nativeFrame; f != nil {
			start, _ := inverse.point(wire.Point{X: (f.X - viewport.X) / viewport.Width, Y: (f.Y - viewport.Y) / viewport.Height})
			end, _ := inverse.point(wire.Point{X: (f.X + f.Width - viewport.X) / viewport.Width, Y: (f.Y + f.Height - viewport.Y) / viewport.Height})
			x, y := float64(g.Width-1), float64(g.Height-1)
			node.Frame = clipFrame(min(start.X, end.X)*x, min(start.Y, end.Y)*y, max(start.X, end.X)*x, max(start.Y, end.Y)*y, g)
		}
		if node.Frame == nil {
			snapshot.Coverage.MissingFrames++
		}
	}
	if snapshot.Coverage.MissingFrames < len(snapshot.Nodes) {
		snapshot.Coverage.CoordinateSpace = "qualified"
	}
}

func clipFrame(left, top, right, bottom float64, g Geometry) *AXFrame {
	if !finite(left) || !finite(top) || !finite(right) || !finite(bottom) {
		return nil
	}
	left, top = max(0, left), max(0, top)
	right, bottom = min(float64(g.Width-1), right), min(float64(g.Height-1), bottom)
	if right <= left || bottom <= top {
		return nil
	}
	return &AXFrame{X: left, Y: top, Width: right - left, Height: bottom - top}
}
func fuseOCR(ax *AXSnapshot, boxes []OCRBox, g Geometry, width, height int) {
	if width < 2 || height < 2 {
		return
	}
	x, y := float64(g.Width)/float64(width), float64(g.Height)/float64(height)
	for i, box := range boxes {
		if len(ax.Nodes) >= 1500 || i >= 1500 {
			ax.Coverage.Truncated = true
			break
		}
		text := axText(box.Text)
		if text == "" || box.Confidence <= 0 || !finite(box.Confidence) {
			continue
		}
		frame := clipFrame(box.X*x, box.Y*y, (box.X+box.Width)*x, (box.Y+box.Height)*y, g)
		if frame == nil {
			continue
		}
		duplicate := false
		for _, node := range ax.Nodes {
			f := node.Frame
			if f == nil {
				continue
			}
			w := min(f.X+f.Width, frame.X+frame.Width) - max(f.X, frame.X)
			h := min(f.Y+f.Height, frame.Y+frame.Height) - max(f.Y, frame.Y)
			if w > 0 && h > 0 && (node.Secure == "yes" || (strings.EqualFold(node.Label, text) && w*h >= frame.Width*frame.Height*0.5)) {
				duplicate = true
				break
			}
		}
		if !duplicate {
			ax.Nodes = append(ax.Nodes, AXNode{NodeID: "ocr-" + uuid.New().String(), Role: "text", Label: text, Frame: frame, Editable: "no", Secure: "unknown", Source: "ocr"})
			ax.Coverage.CoordinateSpace = "qualified"
			ax.Coverage.Returned = len(ax.Nodes)
		}
	}
}

func limitAX(ax *AXSnapshot) {
	if ax.Nodes == nil {
		ax.Nodes = []AXNode{}
	}
	size := 2
	missing, qualified := 0, false
	for i, node := range ax.Nodes {
		encoded, _ := json.Marshal(node)
		size += len(encoded)
		if i > 0 {
			size++
		}
		if size > 32000 {
			ax.Coverage.Truncated = true
			for _, dropped := range ax.Nodes[i:] {
				if dropped.Source != "ocr" {
					ax.Coverage.Unreturned++
				}
			}
			ax.Nodes = ax.Nodes[:i]
			break
		}
		if node.Frame == nil {
			missing++
		} else {
			qualified = true
		}
	}
	ax.Coverage.Returned, ax.Coverage.MissingFrames = len(ax.Nodes), missing
	if !qualified {
		ax.Coverage.CoordinateSpace = "unqualified"
	}
}
