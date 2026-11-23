package phone

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"image"
	"image/png"
	"io"
	"testing"
	"time"

	"github.com/danielpaulus/go-ios/ios/xpc"
	"github.com/steerlabs/opensteer/iphone-bridge/internal/wire"
)

type fixtureChannel struct {
	sent       []map[string]interface{}
	failAt     int
	reply      map[string]interface{}
	receiveErr error
	closed     bool
}

func (f *fixtureChannel) Send(m map[string]interface{}, flags ...uint32) error {
	var b bytes.Buffer
	if err := xpc.EncodeMessage(&b, xpc.Message{Body: m}); err != nil {
		return err
	}
	decoded, err := xpc.DecodeMessage(&b)
	if err != nil {
		return err
	}
	f.sent = append(f.sent, decoded.Body)
	if f.failAt > 0 && len(f.sent) == f.failAt {
		return io.ErrUnexpectedEOF
	}
	return nil
}
func (f *fixtureChannel) ReceiveOnServerClientStream() (map[string]interface{}, error) {
	return f.reply, f.receiveErr
}
func (f *fixtureChannel) Close() error { f.closed = true; return nil }

type fixtureScreen struct {
	foregroundReads []*Foreground
	state           DeviceState
	image           []byte
	channel         *fixtureChannel
	captures        int
	captureDisplay  string
	launches        int
	foreground      *Foreground
	axErr           error
	ax              AXSnapshot
}

func (f *fixtureScreen) State(context.Context) (DeviceState, error) { return f.state, nil }
func (f *fixtureScreen) Capture(_ context.Context, display string) ([]byte, error) {
	f.captureDisplay = display
	f.captures++
	return f.image, nil
}
func (f *fixtureScreen) AX(context.Context) (AXSnapshot, error) { return f.ax, f.axErr }
func (f *fixtureScreen) Foreground(context.Context) (*Foreground, error) {
	if len(f.foregroundReads) > 0 {
		value := f.foregroundReads[0]
		f.foregroundReads = f.foregroundReads[1:]
		if value == nil {
			return nil, wire.Fail(wire.NativeServiceFailed)
		}
		return value, nil
	}
	return f.foreground, nil
}
func (f *fixtureScreen) HID(context.Context) (xpcChannel, error) { return f.channel, nil }
func (f *fixtureScreen) Launch(ctx context.Context, _ string, guard func() error) error {
	if err := guard(); err != nil {
		return err
	}
	f.launches++
	return nil
}
func screenFixture(t *testing.T) (*screenSession, *fixtureScreen, *wire.PerformParams) {
	t.Helper()
	var b bytes.Buffer
	if err := png.Encode(&b, image.NewRGBA(image.Rect(0, 0, 100, 200))); err != nil {
		t.Fatal(err)
	}
	rotation := 0
	g := Geometry{Width: 100, Height: 200, CaptureWidth: 100, CaptureHeight: 200, Rotation: &rotation}
	state := DeviceState{Lock: "unlocked", Display: "on", Rotation: &rotation}
	backend := &fixtureScreen{state: state, image: b.Bytes(), channel: &fixtureChannel{}}
	s := &screenSession{backend: backend, apps: map[string]bool{"fixture.app": true}, observation: &Observation{ObservationToken: "o", NativeEpoch: 1, GeometryRevision: 1, Geometry: g, State: state}}
	p := &wire.PerformParams{ScreenRef: wire.ScreenRef{BindingToken: "b", SessionID: "s", NativeEpoch: 1}, ObservationToken: "o", GeometryRevision: 1, Actions: []wire.Action{{Kind: "tap", Target: &wire.Target{Point: &wire.Point{X: 50, Y: 100}}}}}
	return s, backend, p
}
func noWait(ctx context.Context, _ time.Duration) error { return ctx.Err() }
func okay() error                                       { return nil }
func failure(t *testing.T, err error, code wire.Reason, effect string) *wire.Failure {
	t.Helper()
	var f *wire.Failure
	if !errors.As(err, &f) || f.Code != code || f.Effect != effect {
		t.Fatalf("expected %s/%s, got %v", code, effect, err)
	}
	return f
}
func TestBatchPreflightRejectsAllTextBeforeEffect(t *testing.T) {
	for _, kind := range []string{"type", "clear"} {
		s, b, p := screenFixture(t)
		secret := "sentinel-typed-🔐-한글"
		p.Actions = append(p.Actions, wire.Action{Kind: kind, Text: &secret})
		_, err := s.perform(context.Background(), p, okay, noWait)
		reason := wire.UnsupportedText
		if kind == "clear" {
			reason = wire.UnsupportedClear
		}
		failure(t, err, reason, "not-started")
		if len(b.channel.sent) != 0 || b.captures != 0 || s.observation == nil {
			t.Fatal("preflight had an effect or consumed observation")
		}
	}
}
func TestCancelledGestureLiftsContactAndCannotReplay(t *testing.T) {
	s, b, p := screenFixture(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	wait := func(context.Context, time.Duration) error { cancel(); return ctx.Err() }
	_, err := s.perform(ctx, p, okay, wait)
	failure(t, err, wire.Cancelled, "submitted")
	if len(b.channel.sent) != 2 {
		t.Fatalf("contact not lifted: %d", len(b.channel.sent))
	}
	down := b.channel.sent[0]["payload"].(map[string]interface{})
	up := b.channel.sent[1]["payload"].(map[string]interface{})
	if down["eventType"] != uint64(0) || up["eventType"] != uint64(2) || down["edge"] != uint64(0) {
		t.Fatal("wrong Indigo event numeric types/order")
	}
	point := down["pointOne"].(map[string]interface{})
	if point["x"] != float64(50)/99 || point["y"] != float64(100)/199 {
		t.Fatal("coordinates not normalized")
	}
	_, err = s.perform(context.Background(), p, okay, noWait)
	failure(t, err, wire.StaleObservation, "not-started")
}
func TestFailedWriteStillReleasesAndPreservesKnownPrefix(t *testing.T) {
	s, b, p := screenFixture(t)
	p.Actions = append([]wire.Action{{Kind: "navigate", Button: "home"}}, p.Actions...)
	b.channel.failAt = 3
	_, err := s.perform(context.Background(), p, okay, noWait)
	f := failure(t, err, wire.OutcomeUnknown, "unknown")
	if f.CompletedSteps != 1 || len(b.channel.sent) != 4 {
		t.Fatalf("lost prefix or release: %+v messages=%d", f, len(b.channel.sent))
	}
}
func TestReleaseFailureIsNeverSuccess(t *testing.T) {
	s, b, p := screenFixture(t)
	b.channel.failAt = 2
	_, err := s.perform(context.Background(), p, okay, noWait)
	failure(t, err, wire.OutcomeUnknown, "unknown")
}
func TestEpochGuardImmediatelyBeforeContactAndDuringGesture(t *testing.T) {
	s, b, p := screenFixture(t)
	checks := 0
	guard := func() error {
		checks++
		if checks == 3 {
			return wire.Fail(wire.StaleEpoch)
		}
		return nil
	}
	_, err := s.perform(context.Background(), p, guard, noWait)
	failure(t, err, wire.StaleEpoch, "not-started")
	if len(b.channel.sent) != 0 {
		t.Fatal("contact escaped stale binding")
	}
	s, b, p = screenFixture(t)
	guard = okay
	wait := func(context.Context, time.Duration) error {
		guard = func() error { return wire.Fail(wire.StaleEpoch) }
		return nil
	}
	_, err = s.perform(context.Background(), p, func() error { return guard() }, wait)
	failure(t, err, wire.StaleEpoch, "submitted")
	if len(b.channel.sent) != 2 {
		t.Fatal("revocation did not lift contact")
	}
}
func TestKeyboardReleasesModifiersInReverseOrder(t *testing.T) {
	c := &fixtureChannel{}
	k := keyboard{conn: c}
	ctx, cancel := context.WithCancel(context.Background())
	for _, key := range []uint64{0xe3, 0xe1, 4} {
		if err := k.down(ctx, key, okay); err != nil {
			t.Fatal(err)
		}
	}
	cancel()
	if err := k.release(); err != nil {
		t.Fatal(err)
	}
	for i, key := range []uint64{4, 0xe1, 0xe3} {
		p := c.sent[i+3]["payload"].(map[string]interface{})
		if p["usageCode"] != key || p["state"] != uint64(2) || c.sent[i+3]["messageType"] != "IndigoKeyboardButtonEvent" {
			t.Fatal("wrong keyboard release")
		}
	}
	c = &fixtureChannel{failAt: 1}
	k = keyboard{conn: c}
	failure(t, k.down(context.Background(), 4, okay), wire.OutcomeUnknown, "unknown")
	if err := k.release(); err != nil {
		t.Fatal(err)
	}
	if len(c.sent) != 2 {
		t.Fatal("uncertain key down was not released")
	}
}
func TestLockAndRotationChangesRefuseBeforeInput(t *testing.T) {
	for _, lock := range []string{"unknown", "locked"} {
		s, b, p := screenFixture(t)
		b.state.Lock = lock
		_, err := s.perform(context.Background(), p, okay, noWait)
		if err == nil || len(b.channel.sent) != 0 {
			t.Fatal("unsafe lock state admitted")
		}
	}
	s, b, p := screenFixture(t)
	rotation := 90
	b.state.Rotation = &rotation
	_, err := s.perform(context.Background(), p, okay, noWait)
	failure(t, err, wire.StaleObservation, "not-started")
	if len(b.channel.sent) != 0 {
		t.Fatal("rotation reused transform")
	}
}
func TestAppLaunchLostReplyIsUnknownWithoutReplay(t *testing.T) {
	c := &fixtureChannel{receiveErr: io.EOF}
	open := func(context.Context, string) (xpcChannel, error) { return c, nil }
	err := launchApp(context.Background(), open, "fixture.app", okay)
	failure(t, err, wire.OutcomeUnknown, "unknown")
	if len(c.sent) != 1 || !c.closed {
		t.Fatal("launch was replayed or connection retained")
	}
	input := c.sent[0]["CoreDevice.input"].(map[string]interface{})
	options := input["options"].(map[string]interface{})
	if options["terminateExisting"] != false || options["startStopped"] != false || len(options["arguments"].([]interface{})) != 0 {
		t.Fatal("launch enables extra authority")
	}
}
func TestObserveUsesSameGeometryWithoutReturningImage(t *testing.T) {
	s, b, _ := screenFixture(t)
	b.ax = AXSnapshot{Nodes: []AXNode{}, Coverage: AXCoverage{Status: "unavailable", Reason: "accessibility-unavailable"}}
	include := false
	o, err := s.observe(context.Background(), &wire.ObserveParams{ScreenRef: wire.ScreenRef{NativeEpoch: 1}, IncludeScreenshot: &include}, okay)
	if err != nil {
		t.Fatal(err)
	}
	observation := o.(*Observation)
	if b.captures != 1 {
		t.Fatalf("observe captured %d PNGs", b.captures)
	}
	if observation.Screenshot != nil || observation.Geometry.Width != 100 || observation.Geometry.Height != 200 || observation.ObservationToken == "o" {
		t.Fatal("invalid image-free observation")
	}
}

func TestBlockedObservationExposesOnlyStateAndInvalidatesInput(t *testing.T) {
	for _, tc := range []struct {
		lock, display string
		reason        wire.Reason
	}{
		{"locked", "on", wire.PhoneLocked},
		{"unknown", "on", wire.LockUnknown},
		{"unlocked", "off", wire.WakeRequired},
		{"unlocked", "unknown", wire.DisplayUnknown},
	} {
		t.Run(string(tc.reason), func(t *testing.T) {
			s, b, input := screenFixture(t)
			b.state.Lock, b.state.Display = tc.lock, tc.display
			include := true
			value, err := s.observe(context.Background(), &wire.ObserveParams{
				ScreenRef: wire.ScreenRef{NativeEpoch: 1}, IncludeScreenshot: &include,
			}, okay)
			result, isStatus := value.(*ScreenStatus)
			if err != nil || !isStatus || result.Reason != tc.reason || b.captures != 0 {
				t.Fatalf("expected a state-only result without capture, got %T / %v", value, err)
			}
			_, err = s.perform(context.Background(), input, okay, noWait)
			failure(t, err, wire.StaleObservation, "not-started")
			if len(b.channel.sent) != 0 {
				t.Fatal("a state-only observation admitted input")
			}
		})
	}
}

type lockDuringCapture struct{ *fixtureScreen }

func (f lockDuringCapture) Capture(ctx context.Context, display string) ([]byte, error) {
	data, err := f.fixtureScreen.Capture(ctx, display)
	f.state.Lock = "locked"
	return data, err
}

func TestRelockingDuringCaptureDiscardsScreenContent(t *testing.T) {
	s, b, input := screenFixture(t)
	s.backend = lockDuringCapture{b}
	include := true
	value, err := s.observe(context.Background(), &wire.ObserveParams{
		ScreenRef: wire.ScreenRef{NativeEpoch: 1}, IncludeScreenshot: &include,
	}, okay)
	status, ok := value.(*ScreenStatus)
	if err != nil || !ok || status.Reason != wire.PhoneLocked || b.captures != 1 {
		t.Fatalf("expected a redacted locked status, got %T / %v", value, err)
	}
	_, err = s.perform(context.Background(), input, okay, noWait)
	failure(t, err, wire.StaleObservation, "not-started")
}
func TestDragMovesUseOneContactAndBoundedMonotonicIntervals(t *testing.T) {
	s, b, p := screenFixture(t)
	p.Actions[0] = wire.Action{Kind: "drag", Target: &wire.Target{Point: &wire.Point{X: 0, Y: 0}}, To: &wire.Point{X: 99, Y: 199}, DurationMs: 64, HoldMs: 300}
	var intervals []time.Duration
	wait := func(ctx context.Context, d time.Duration) error { intervals = append(intervals, d); return ctx.Err() }
	result, e := s.perform(context.Background(), p, okay, wait)
	if e != nil {
		t.Fatal(e)
	}
	if result.(PerformResult).CompletedSteps != 1 || len(b.channel.sent) != 6 || len(intervals) != 5 || intervals[0] != 300*time.Millisecond {
		t.Fatal("drag timing/contact sequence lost")
	}
	for i, event := range b.channel.sent {
		payload := event["payload"].(map[string]interface{})
		want := uint64(1)
		if i == 0 {
			want = 0
		}
		if i == 5 {
			want = 2
		}
		if payload["eventType"] != want {
			t.Fatal("wrong drag phase")
		}
	}
	last := b.channel.sent[4]["payload"].(map[string]interface{})["pointOne"].(map[string]interface{})
	if last["x"] != float64(1) || last["y"] != float64(1) {
		t.Fatal("drag did not reach normalized endpoint")
	}
}
func TestWakeKnownOnDoesNotToggleLock(t *testing.T) {
	s, b, p := screenFixture(t)
	p.Actions = []wire.Action{{Kind: "wake"}}
	result, e := s.perform(context.Background(), p, okay, noWait)
	if e != nil {
		t.Fatal(e)
	}
	if result.(PerformResult).Effect != "not-started" || len(b.channel.sent) != 0 {
		t.Fatal("wake toggled an already-on display")
	}
}

type wakeOnButtonScreen struct{ *fixtureScreen }

func (w wakeOnButtonScreen) State(ctx context.Context) (DeviceState, error) {
	state, err := w.fixtureScreen.State(ctx)
	if len(w.channel.sent) >= 2 {
		state.Display = "on"
	}
	return state, err
}

func TestScreenOffStatusAllowsOnlyWake(t *testing.T) {
	for _, lock := range []string{"unlocked", "locked"} {
		t.Run(lock, func(t *testing.T) {
			s, b, _ := screenFixture(t)
			b.state.Lock, b.state.Display = lock, "off"
			s.backend = wakeOnButtonScreen{b}
			include := false
			value, err := s.observe(context.Background(), &wire.ObserveParams{
				ScreenRef: wire.ScreenRef{BindingToken: "b", SessionID: "s", NativeEpoch: 1}, IncludeScreenshot: &include,
			}, okay)
			status, ok := value.(*ScreenStatus)
			if err != nil || !ok || status.WakeToken == "" || status.GeometryRevision == 0 {
				t.Fatalf("expected screen-off status with wake token, got %#v / %v", value, err)
			}
			// Non-wake actions must be refused even with the wake token.
			nonWake := &wire.PerformParams{
				ScreenRef:        wire.ScreenRef{BindingToken: "b", SessionID: "s", NativeEpoch: 1},
				ObservationToken: status.WakeToken,
				GeometryRevision: status.GeometryRevision,
				Actions:          []wire.Action{{Kind: "tap", Target: &wire.Target{Point: &wire.Point{X: 10, Y: 10}}}},
			}
			_, err = s.perform(context.Background(), nonWake, okay, noWait)
			failure(t, err, wire.StaleObservation, "not-started")
			if len(b.channel.sent) != 0 {
				t.Fatal("wake token admitted non-wake input")
			}
			// A single wake action succeeds and sends a side-button pulse.
			wakeReq := &wire.PerformParams{
				ScreenRef:        wire.ScreenRef{BindingToken: "b", SessionID: "s", NativeEpoch: 1},
				ObservationToken: status.WakeToken,
				GeometryRevision: status.GeometryRevision,
				Actions:          []wire.Action{{Kind: "wake"}},
			}
			res, err := s.perform(context.Background(), wakeReq, okay, noWait)
			if err != nil {
				t.Fatalf("wake failed: %v", err)
			}
			if res.(PerformResult).Effect != "submitted" || res.(PerformResult).CompletedSteps != 1 || len(b.channel.sent) < 2 {
				t.Fatalf("unexpected wake result %#v (sent=%d)", res, len(b.channel.sent))
			}
			// Replaying the same wake token is rejected.
			_, err = s.perform(context.Background(), wakeReq, okay, noWait)
			failure(t, err, wire.StaleObservation, "not-started")
		})
	}
}
func TestNativeServiceErrorsNeverExposePrivateText(t *testing.T) {
	c := &fixtureChannel{receiveErr: errors.New("SENTINEL_UDID_PAIR_KEY_AX_TYPED_SECRET")}
	e := launchApp(context.Background(), func(context.Context, string) (xpcChannel, error) { return c, nil }, "fixture.app", okay)
	f := failure(t, e, wire.OutcomeUnknown, "unknown")
	encoded, err := json.Marshal(f)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(encoded, []byte("SENTINEL")) {
		t.Fatal("native failure leaked private text")
	}
}
func TestKeyboardChordCancellationAutomaticallyReleases(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	calls := 0
	c := &fixtureChannel{}
	guard := func() error {
		calls++
		if calls == 2 {
			cancel()
			return wire.Fail(wire.Cancelled)
		}
		return nil
	}
	e := keyboardChord(ctx, c, []uint64{0xe3, 4}, guard)
	failure(t, e, wire.Cancelled, "submitted")
	if len(c.sent) != 2 || c.sent[1]["payload"].(map[string]interface{})["state"] != uint64(2) {
		t.Fatal("keyboard cancellation left modifier held")
	}
	c = &fixtureChannel{failAt: 2}
	e = keyboardChord(context.Background(), c, []uint64{4}, okay)
	failure(t, e, wire.OutcomeUnknown, "unknown")
}
func TestSessionCloseWaitsForContactRelease(t *testing.T) {
	screen, b, p := screenFixture(t)
	session := &Session{screen: screen}
	entered := make(chan struct{})
	done := make(chan error, 1)
	wait := func(ctx context.Context, _ time.Duration) error { close(entered); <-ctx.Done(); return ctx.Err() }
	go func() { _, e := screen.perform(context.Background(), p, okay, wait); done <- e }()
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("gesture never put its contact down")
	}
	if e := session.Close(); e != nil {
		t.Fatal(e)
	}
	select {
	case e := <-done:
		failure(t, e, wire.Cancelled, "submitted")
	case <-time.After(time.Second):
		t.Fatal("session closed before gesture settled")
	}
	if len(b.channel.sent) != 2 || b.channel.sent[1]["payload"].(map[string]interface{})["eventType"] != uint64(2) {
		t.Fatal("session teardown left contact held")
	}
}

func TestEveryInputCloseDrainsAfterFinalRelease(t *testing.T) {
	for _, button := range []bool{false, true} {
		for _, abort := range []bool{false, true} {
			c := &fixtureChannel{}
			ctx, cancel := context.WithCancel(context.Background())
			drained := false
			input := &gracefulInput{xpcChannel: c, wait: func(cleanup context.Context, d time.Duration) error {
				if cleanup.Err() != nil || d <= 0 || d > inputCloseGrace || c.closed || len(c.sent) != 2 {
					t.Fatal("closed before release drained")
				}
				drained = true
				return nil
			}}
			hold := func(context.Context, time.Duration) error {
				if abort {
					cancel()
					return ctx.Err()
				}
				return nil
			}
			if button {
				_ = pressButton(ctx, input, "home", func() error { return ctx.Err() }, hold)
			} else {
				rotation := 0
				_ = gesture(ctx, input, Geometry{Rotation: &rotation}, wire.Point{}, wire.Action{Kind: "tap"}, func() error { return ctx.Err() }, hold)
			}
			if err := input.Close(); err != nil {
				t.Fatal(err)
			}
			cancel()
			if !drained || !c.closed {
				t.Fatal("release was not drained")
			}
		}
	}
}

func TestObserveVerifiesForegroundWithoutAccessibility(t *testing.T) {
	s, backend, _ := screenFixture(t)
	backend.axErr = wire.Fail(wire.AccessibilityUnavailable)
	backend.foreground = &Foreground{AppID: "example.app", Label: "Example"}
	include := true
	result, err := s.observe(context.Background(), &wire.ObserveParams{ScreenRef: wire.ScreenRef{NativeEpoch: 1}, IncludeScreenshot: &include}, okay)
	if err != nil {
		t.Fatal(err)
	}
	observation := result.(*Observation)
	if observation.Foreground == nil || observation.Foreground.AppID != "example.app" || observation.Screenshot == nil {
		t.Fatal("AX failure hid a verified foreground screenshot")
	}
}

func TestObserveKeepsTheScreenshotWhenTheFrontAppIsUnknown(t *testing.T) {
	s, backend, _ := screenFixture(t)
	backend.axErr = wire.Fail(wire.AccessibilityUnavailable)
	backend.foregroundReads = []*Foreground{nil}
	include := true
	result, err := s.observe(context.Background(), &wire.ObserveParams{ScreenRef: wire.ScreenRef{NativeEpoch: 1}, IncludeScreenshot: &include}, okay)
	if err != nil {
		t.Fatal(err)
	}
	if o := result.(*Observation); o.Foreground != nil || o.Screenshot == nil {
		t.Fatal("an unknown front app hid the screenshot")
	}
	// The person left Opensteer between the capture's readings: its pixels stay private.
	backend.foregroundReads = []*Foreground{{AppID: opensteerAppID}, nil}
	result, err = s.observe(context.Background(), &wire.ObserveParams{ScreenRef: wire.ScreenRef{NativeEpoch: 1}, IncludeScreenshot: &include}, okay)
	if err != nil {
		t.Fatal(err)
	}
	o := result.(*Observation)
	if o.Foreground == nil || o.Foreground.AppID != opensteerAppID || o.Screenshot != nil || len(o.Nodes) != 0 {
		t.Fatal("expected only the identity of Opensteer's own screen")
	}
}
