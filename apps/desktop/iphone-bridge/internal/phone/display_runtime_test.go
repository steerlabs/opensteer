package phone

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"image"
	"image/jpeg"
	"net"
	"os"
	"path/filepath"
	"reflect"
	"sync"
	"testing"
	"time"

	"github.com/danielpaulus/go-ios/ios"
	"github.com/danielpaulus/go-ios/ios/xpc"
	"github.com/steerlabs/opensteer/iphone-bridge/internal/wire"
)

type runtimeScreen struct {
	*fixtureScreen
	mu          sync.Mutex
	hid         []*fixtureChannel
	dials       int
	wakeOnPress bool
	focus       []focusedField
	focusErr    error
	clipboard   *runtimeClipboard
}

func (f *runtimeScreen) State(context.Context) (DeviceState, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.wakeOnPress && len(f.channel.sent) >= 2 {
		f.state.Display = "on"
	}
	return f.state, nil
}
func (f *runtimeScreen) HID(context.Context) (xpcChannel, error) {
	f.dials++
	if len(f.hid) > 0 {
		return f.hid[f.dials-1], nil
	}
	return f.channel, nil
}
func (f *runtimeScreen) Focus(context.Context) (focusedField, error) {
	if f.focusErr != nil {
		return focusedField{}, f.focusErr
	}
	if len(f.focus) == 0 {
		return focusedField{}, errNoField
	}
	value := f.focus[0]
	f.focus = f.focus[1:]
	return value, nil
}
func (f *runtimeScreen) Pasteboard() phonePasteboard { return f.clipboard }

func TestPersistentHIDReuseAndReconnect(t *testing.T) {
	s, b, _ := screenFixture(t)
	first, second := &fixtureChannel{}, &fixtureChannel{}
	backend := &runtimeScreen{fixtureScreen: b, hid: []*fixtureChannel{first, second}}
	s.backend = backend
	ctx := context.Background()
	send := func(c xpcChannel) error { return pressButton(ctx, c, "home", okay, noWait) }
	for range 2 {
		if err := s.withInput(ctx, send); err != nil {
			t.Fatal(err)
		}
	}
	if backend.dials != 1 || first.closed || len(first.sent) != 4 {
		t.Fatal("channel was not reused")
	}
	first.failAt = 5
	failure(t, s.withInput(ctx, send), wire.OutcomeUnknown, "unknown")
	if !first.closed || len(first.sent) != 6 {
		t.Fatal("uncertain hold was not released before disconnect")
	}
	if err := s.withInput(ctx, send); err != nil {
		t.Fatal(err)
	}
	if backend.dials != 2 || len(second.sent) != 2 {
		t.Fatal("failed effect was replayed or channel did not reconnect")
	}
	s.close()
	if !second.closed {
		t.Fatal("session did not close the warm channel")
	}
}

type runtimeClipboard struct {
	current         clipboardSnapshot
	writes          int
	pulls           int
	concurrent      bool
	omitSetChange   bool
	setErrAfterSave error
}

func (c *runtimeClipboard) pull(context.Context) (clipboardSnapshot, error) {
	c.pulls++
	if c.concurrent && c.pulls == 2 {
		c.current.items = textClipboard("fixture newer clipboard")
		c.current.change++
	}
	return c.current, nil
}
func (c *runtimeClipboard) set(_ context.Context, items []interface{}, guard func() error) (clipboardSnapshot, error) {
	if err := guard(); err != nil {
		return clipboardSnapshot{}, err
	}
	c.current.items = items
	c.current.change++
	c.writes++
	if c.setErrAfterSave != nil && c.writes == 1 {
		return clipboardSnapshot{}, c.setErrAfterSave
	}
	reply := c.current
	if c.omitSetChange && c.writes == 1 {
		reply.hasChange = false
	}
	return reply, nil
}

func TestHybridTypingAndClear(t *testing.T) {
	field := func(value string) focusedField {
		return focusedField{ID: 1, Secure: "no", Editable: "yes", Value: &value}
	}
	for _, tc := range []struct {
		name, text string
		focus      []focusedField
		uses       []uint64
		writes     int
	}{
		{"ascii", "A!", []focusedField{field(""), field("A!")}, []uint64{0xe1, 4, 0xe1, 0x1e}, 0},
		{"paste", "你好🙂\n", []focusedField{field(""), field(""), field("你好🙂\n")}, []uint64{0xe3, 0x19}, 2},
		{"layout", "A", []focusedField{field(""), field("á"), field("á"), field("A")}, []uint64{0xe1, 4, 0xe3, 4, 0xe3, 0x19}, 2},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s, b, _ := screenFixture(t)
			board := &runtimeClipboard{current: clipboardSnapshot{items: textClipboard("fixture original"), change: 10, hasChange: true}}
			backend := &runtimeScreen{fixtureScreen: b, focus: tc.focus, clipboard: board}
			s.backend = backend
			defer s.close()
			if err := s.typeText(context.Background(), tc.text, false, okay); err != nil {
				t.Fatal(err)
			}
			if got := keyDowns(b.channel); !reflect.DeepEqual(got, tc.uses) || board.writes != tc.writes || !reflect.DeepEqual(board.current.items, textClipboard("fixture original")) {
				t.Fatal("hybrid input or restoration differs")
			}
			backend.focus = []focusedField{field(tc.text), field("")}
			if err := s.clearField(context.Background(), okay); err != nil {
				t.Fatal(err)
			}
			if got := keyDowns(b.channel); !reflect.DeepEqual(got[len(tc.uses):], []uint64{0xe3, 4, 0x2a}) {
				t.Fatal("wrong clear chord")
			}
		})
	}
	s, b, _ := screenFixture(t)
	board := &runtimeClipboard{}
	s.backend = &runtimeScreen{fixtureScreen: b, focus: []focusedField{{Secure: "yes"}, {Secure: "yes"}}, clipboard: board}
	if err := s.typeText(context.Background(), "🙂", true, okay); !errors.Is(err, errSensitive) {
		t.Fatal(err)
	}
	if err := s.clearField(context.Background(), okay); !errors.Is(err, errSensitive) {
		t.Fatal(err)
	}
	if board.pulls != 0 || board.writes != 0 || len(b.channel.sent) != 0 {
		t.Fatal("secure input touched clipboard or HID")
	}
}
func keyDowns(c *fixtureChannel) []uint64 {
	var usages []uint64
	for _, event := range c.sent {
		payload := event["payload"].(map[string]interface{})
		if payload["state"] == uint64(1) && event["messageType"] == "IndigoKeyboardButtonEvent" {
			usages = append(usages, payload["usageCode"].(uint64))
		}
	}
	return usages
}
func TestPasteboardPullAndConditionalRestore(t *testing.T) {
	board := &runtimeClipboard{current: clipboardSnapshot{items: textClipboard("original"), change: 2, hasChange: true}, concurrent: true}
	if err := pasteTransaction(context.Background(), board, "staged", okay, okay); err != nil {
		t.Fatal(err)
	}
	if board.writes != 1 || !reflect.DeepEqual(board.current.items, textClipboard("fixture newer clipboard")) {
		t.Fatal("concurrent clipboard overwritten")
	}
	for _, tc := range []struct {
		items  []interface{}
		reason wire.Reason
	}{
		{[]interface{}{map[string]interface{}{"confidential": true}}, wire.UnsupportedText},
		{textClipboard(string(make([]byte, maxPasteboardBytes))), wire.NativeLimit},
	} {
		c := &fixtureChannel{reply: map[string]interface{}{"command": "PULL_REPLY", "snapshot": map[string]interface{}{"items": tc.items}}}
		client := pasteboard{open: func(_ context.Context, service string) (xpcChannel, error) {
			if service != pasteboardService {
				t.Fatal("wrong pasteboard service")
			}
			return c, nil
		}}
		_, err := client.pull(context.Background())
		failure(t, err, tc.reason, "not-started")
		if len(c.sent) != 1 || c.sent[0]["pasteboardName"] != "general" || c.sent[0]["dataPolicy"].(map[string]interface{})["promiseSecondary"] == nil {
			t.Fatal("wrong PULL shape")
		}
	}
}
func TestWakeDoubleTapRotatedEdgesAndPinch(t *testing.T) {
	s, b, p := screenFixture(t)
	b.state.Display = "off"
	s.backend = &runtimeScreen{fixtureScreen: b, wakeOnPress: true}
	var delays []time.Duration
	wait := func(ctx context.Context, d time.Duration) error { delays = append(delays, d); return ctx.Err() }
	p.Actions = []wire.Action{{Kind: "wake"}}
	if _, err := s.perform(context.Background(), p, okay, wait); err != nil {
		t.Fatal(err)
	}
	if len(delays) != 1 || delays[0] != 50*time.Millisecond || len(b.channel.sent) != 2 {
		t.Fatal("wake did not tap the Side button")
	}
	defer s.close()
	ctx := context.Background()
	rotation := 90
	g := Geometry{Width: 100, Height: 200, Rotation: &rotation, DisplayID: 1}
	if swipeEdge("top", wire.Point{}, &rotation) != 2 || swipeEdge("", wire.Point{X: .99, Y: .6}, &rotation) != 4 {
		t.Fatal("wrong rotated edge")
	}
	c := &fixtureChannel{}
	delays = nil
	if err := gesture(ctx, c, g, wire.Point{X: .5, Y: .5}, wire.Action{Kind: "tap", Count: 2}, okay, wait); err != nil {
		t.Fatal(err)
	}
	if len(c.sent) != 4 || delays[1] != 80*time.Millisecond {
		t.Fatal("wrong double-tap interval")
	}
	c = &fixtureChannel{}
	canceled, cancel := context.WithCancel(ctx)
	if err := gesture(canceled, c, g, wire.Point{X: .5, Y: .5}, wire.Action{Kind: "pinch", Scale: 2, DurationMs: 100}, okay, func(context.Context, time.Duration) error { cancel(); return canceled.Err() }); err == nil {
		t.Fatal("pinch ignored cancellation")
	}
	if len(c.sent) != 2 || c.sent[1]["payload"].(map[string]interface{})["pointTwo"] == nil || c.sent[1]["payload"].(map[string]interface{})["eventType"] != uint64(2) {
		t.Fatal("pinch left a contact held")
	}
}

type fixtureMedia struct {
	cfg       MediaPipelineConfig
	socket    *net.UnixListener
	frame     *MediaFrame
	profile   [2]int
	hidden    []string
	resumes   int
	refreshes int
	stopped   bool
}

func (f *fixtureMedia) Start(context.Context) (string, error) {
	listener, err := net.ListenUnix("unix", &net.UnixAddr{Name: f.cfg.SocketPath, Net: "unix"})
	if err != nil {
		return "", err
	}
	f.socket = listener
	if err := os.Chmod(f.cfg.SocketPath, 0600); err != nil {
		return "", err
	}
	f.cfg.OnState(DisplayStateEvent{StreamID: f.cfg.StreamID, State: "starting", Generation: 1})
	return f.cfg.SocketPath, nil
}
func (f *fixtureMedia) UpdateDemand(w, h int)                         { f.profile = [2]int{w, h} }
func (f *fixtureMedia) RequestKeyframe()                              { f.refreshes++ }
func (f *fixtureMedia) LatestFrame(time.Duration) (*MediaFrame, bool) { return f.frame, f.frame != nil }
func (f *fixtureMedia) SetPrivacyHidden(_ string, reason string)      { f.hidden = append(f.hidden, reason) }
func (f *fixtureMedia) ResumeVisible(uint64, int)                     { f.resumes++ }
func (f *fixtureMedia) Stop(context.Context) error                    { f.stopped = true; return f.socket.Close() }

func TestDisplayLifecycleAndOwnerInput(t *testing.T) {
	ctx := context.Background()
	screen, backend, _ := screenFixture(t)
	screen.backend = &runtimeScreen{fixtureScreen: backend}
	root, err := os.MkdirTemp("/tmp", "ib-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(root) })
	m := NewManager(ctx, nil, nil)
	defer m.Close()
	m.rootPath = root
	session := &Session{screen: screen}
	m.phones["fixture"] = &localPhone{id: "fixture", binding: "binding", epoch: 1, session: session, entry: ios.DeviceEntry{DeviceID: 1}, lane: make(chan struct{}, 1), routeCtx: ctx}
	var pipeline *fixtureMedia
	var starting bool
	m.SetDisplayBackend(func(_ context.Context, native *Session, cfg MediaPipelineConfig) (MediaPipeline, error) {
		if native != session {
			t.Fatal("factory received wrong session")
		}
		pipeline = &fixtureMedia{cfg: cfg}
		return pipeline, nil
	}, nil, func(event wire.DisplayStateEvent) { starting = event.State == "starting" })
	ref := wire.DisplayRef{BindingToken: "binding", NativeEpoch: 1, StreamID: "dsp_c2a11f7c-8568-4d02-80ec-754ae26bb150"}
	result, err := m.displayOperation(ctx, "display.start", &wire.DisplayStartParams{DisplayRef: ref, MaxLongSide: 1280, MaxFPS: 30})
	if err != nil || !starting {
		t.Fatalf("display did not start: %v", err)
	}
	path := result.(wire.DisplayStartResult).SocketPath
	if filepath.Dir(path) != root {
		t.Fatal("media socket outside private root")
	}
	// End the monitor before manually exercising state transitions.
	screen.display.cancelMonitor()
	<-screen.display.monitorDone
	fps := 24
	if _, err := m.displayOperation(ctx, "display.demand", &wire.DisplayDemandParams{DisplayRef: ref, MaxFPS: &fps}); err != nil {
		t.Fatal(err)
	}
	if _, err := m.displayOperation(ctx, "display.refresh", &ref); err != nil || pipeline.profile != [2]int{1280, 24} || pipeline.refreshes != 1 {
		t.Fatal("demand or refresh lost")
	}
	var events []wire.DisplayInputEvent
	if err := json.Unmarshal([]byte(`[{"kind":"pointer","phase":"down","x":0.2,"y":0.4,"t":0},{"kind":"key","action":"down","code":"KeyA","key":"a","modifiers":["shift"]}]`), &events); err != nil {
		t.Fatal(err)
	}
	staleGen := uint64(99)
	result, err = m.displayOperation(ctx, "display.input", &wire.DisplayInputParams{DisplayRef: ref, Geometry: &staleGen, Events: events})
	if err != nil || result.(wire.DisplayInputResult).Outcome != "stale" || screen.ownerInputHeld() {
		t.Fatalf("stale geometry admitted owner input: %+v / %v", result, err)
	}
	currentGen := uint64(1)
	result, err = m.displayOperation(ctx, "display.input", &wire.DisplayInputParams{DisplayRef: ref, Geometry: &currentGen, Events: events})
	if err != nil || result.(wire.DisplayInputResult).Outcome != "dispatched" || !screen.ownerInputHeld() {
		t.Fatal("owner input not held")
	}
	// Closing an agent session must not tear down an active owner display stream or owner input.
	m.phones["fixture"].sessionID = "agent-session"
	if err := m.closeSession("binding", "agent-session"); err != nil {
		t.Fatal(err)
	}
	if pipeline.stopped || !screen.ownerInputHeld() {
		t.Fatal("closing agent session tore down independent owner display stream")
	}
	if _, err := m.displayOperation(ctx, "display.inputReset", &ref); err != nil || screen.ownerInputHeld() || len(backend.channel.sent) != 6 {
		t.Fatal("owner reset did not release pointer and keys")
	}
	backend.state.Lock = "unknown"
	result, _ = m.displayOperation(ctx, "display.input", &wire.DisplayInputParams{DisplayRef: ref, Events: events})
	if result.(wire.DisplayInputResult).Outcome != "refused" || len(pipeline.hidden) == 0 {
		t.Fatal("unknown lock state did not flush the display")
	}
	backend.state.Lock = "unlocked"
	result, err = m.displayOperation(ctx, "display.power", &wire.DisplayPowerParams{DisplayRef: ref, Action: "lock"})
	if err != nil || result.(wire.DisplayInputResult).Outcome != "dispatched" || pipeline.hidden[len(pipeline.hidden)-1] != "locked-screen" {
		t.Fatal("power lock did not protect the stream")
	}
	if _, err := m.displayOperation(ctx, "display.stop", &ref); err != nil || !pipeline.stopped {
		t.Fatalf("display did not stop: %v", err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("media socket survived stop")
	}
}

func TestMediaObservationAndOCRFuseQualifiedTargets(t *testing.T) {
	s, b, p := screenFixture(t)
	b.state.viewport = AXFrame{Width: 100, Height: 200}
	b.ax = AXSnapshot{viewportFrames: true, Nodes: []AXNode{{NodeID: "n1", Label: "fixture", Source: "ax", nativeFrame: &AXFrame{X: 10, Y: 20, Width: 30, Height: 15}}}}
	var encoded bytes.Buffer
	if err := jpeg.Encode(&encoded, image.NewRGBA(image.Rect(0, 0, 100, 200)), nil); err != nil {
		t.Fatal(err)
	}
	live := &fixtureMedia{frame: &MediaFrame{JPEG: encoded.Bytes(), Width: 100, Height: 200, DisplayID: b.state.DisplayID, CapturedAt: time.Now()}}
	s.display = &displaySession{ref: wire.DisplayRef{NativeEpoch: p.NativeEpoch}, pipeline: live, displayID: b.state.DisplayID}
	s.visionOCR = func(_ context.Context, frame MediaFrame) ([]OCRBox, error) {
		if !bytes.Equal(frame.JPEG, encoded.Bytes()) {
			t.Fatal("capture was not the media frame")
		}
		return []OCRBox{{Text: "fixture", X: 11, Y: 21, Width: 26, Height: 12, Confidence: 1}, {Text: "visible", X: 55, Y: 65, Width: 20, Height: 20, Confidence: 1}}, nil
	}
	include := true
	result, err := s.observe(context.Background(), &wire.ObserveParams{ScreenRef: p.ScreenRef, IncludeScreenshot: &include}, okay)
	if err != nil {
		t.Fatal(err)
	}
	o := result.(*Observation)
	if b.captures != 0 || o.Coverage.CoordinateSpace != "qualified" || len(o.Nodes) != 2 || o.Nodes[1].Source != "ocr" {
		t.Fatal("media fast path or AX/OCR fusion failed")
	}
	if _, err := targetPoint(o, &wire.Target{NodeID: o.Nodes[1].NodeID}); err != nil {
		t.Fatal(err)
	}
}

func TestDisplayStartsProtectedWithScreenOff(t *testing.T) {
	screen, backend, _ := screenFixture(t)
	backend.state.Display = "off"
	root, err := os.MkdirTemp("/tmp", "ib-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(root) })
	t.Cleanup(screen.close)
	var media *fixtureMedia
	factory := func(_ context.Context, _ *Session, cfg MediaPipelineConfig) (MediaPipeline, error) {
		media = &fixtureMedia{cfg: cfg}
		return media, nil
	}
	params := &wire.DisplayStartParams{DisplayRef: wire.DisplayRef{NativeEpoch: 1}, MaxLongSide: 1280, MaxFPS: 30}
	if _, err := screen.startDisplay(context.Background(), params, nil, nil, root, factory, nil, okay, okay); err != nil {
		t.Fatal(err)
	}
	screen.display.cancelMonitor()
	<-screen.display.monitorDone
	if screen.display.hidden != "screen-off" || len(media.hidden) == 0 {
		t.Fatal("screen-off session started visible")
	}
	backend.state.Display = "on"
	screen.applyPrivacy(backend.state, &Foreground{AppID: opensteerAppID}, true)
	if screen.display.hidden != "protected" || media.hidden[len(media.hidden)-1] != "opensteer-app" {
		t.Fatal("Opensteer display was not protected")
	}
	// A failed foreground lookup (foregroundKnown=false) must never lift the privacy shield.
	resumesBefore := media.resumes
	screen.applyPrivacy(backend.state, nil, false)
	if screen.display.hidden != "protected" || media.resumes != resumesBefore {
		t.Fatal("unknown foreground app lifted the privacy shield")
	}
	// Even during observe, a failed foreground read keeps the stream protected.
	backend.foregroundReads = []*Foreground{nil, nil, nil}
	include := false
	if _, err := screen.observe(context.Background(), &wire.ObserveParams{ScreenRef: wire.ScreenRef{NativeEpoch: 1}, IncludeScreenshot: &include}, okay); err != nil {
		t.Fatal(err)
	}
	if screen.display.hidden != "protected" || media.resumes != resumesBefore {
		t.Fatal("observe with failed foreground lookup lifted the privacy shield")
	}
	// Once a foreground check succeeds and confirms a non-Opensteer app, the stream resumes.
	screen.applyPrivacy(backend.state, &Foreground{AppID: "com.apple.Preferences"}, true)
	if screen.display.hidden != "" || media.resumes != resumesBefore+1 {
		t.Fatal("verified non-Opensteer foreground app did not resume display")
	}
}

func TestKeysRefusedWhenFocusCheckFailsOrIsUnknown(t *testing.T) {
	ctx := context.Background()
	for _, tc := range []struct {
		name     string
		focus    []focusedField
		focusErr error
	}{
		{"accessibility-failure", nil, wire.Fail(wire.AccessibilityUnavailable)},
		{"unknown-security", []focusedField{{ID: 1, Secure: "unknown", Editable: "yes"}, {ID: 1, Secure: "unknown", Editable: "yes"}}, nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s, b, p := screenFixture(t)
			s.backend = &runtimeScreen{fixtureScreen: b, focus: tc.focus, focusErr: tc.focusErr}
			defer s.close()
			code, key := "KeyA", "a"
			if err := s.ownerKeyEvent(ctx, wire.DisplayInputEvent{Kind: "key", Action: "down", Code: &code, Key: &key}, okay); err == nil {
				t.Fatal("owner key bypassed failed/unknown focus check")
			}
			p.Actions = []wire.Action{{Kind: "key", Key: "a"}}
			if _, err := s.perform(ctx, p, okay, noWait); err == nil {
				t.Fatal("agent key bypassed failed/unknown focus check")
			}
			if len(b.channel.sent) != 0 {
				t.Fatalf("refused keys sent %d HID events", len(b.channel.sent))
			}
		})
	}
}

func TestPasteboardMissingChangeCountAndBadSetReply(t *testing.T) {
	ctx := context.Background()
	// Missing changeCount on initial pull must fail before touching the clipboard.
	untrackedPull := &runtimeClipboard{current: clipboardSnapshot{items: textClipboard("original"), hasChange: false}}
	inserted := false
	err := pasteTransaction(ctx, untrackedPull, "staged", okay, func() error { inserted = true; return nil })
	failure(t, err, wire.UnsupportedText, "not-started")
	if untrackedPull.writes != 0 || inserted || !reflect.DeepEqual(untrackedPull.current.items, textClipboard("original")) {
		t.Fatal("untracked saved clipboard was overwritten")
	}

	// Missing changeCount on set reply must refuse insert and restore the original clipboard.
	untrackedSet := &runtimeClipboard{current: clipboardSnapshot{items: textClipboard("original"), change: 5, hasChange: true}, omitSetChange: true}
	err = pasteTransaction(ctx, untrackedSet, "staged", okay, func() error { inserted = true; return nil })
	failure(t, err, wire.UnsupportedText, "not-started")
	if inserted || untrackedSet.writes != 2 || !reflect.DeepEqual(untrackedSet.current.items, textClipboard("original")) {
		t.Fatalf("missing set changeCount skipped cleanup: inserted=%v writes=%d", inserted, untrackedSet.writes)
	}

	// Unreadable SET_REPLY in pasteboard.set must return an error, and pasteTransaction restores.
	badSet := &fixtureChannel{reply: map[string]interface{}{"command": "SET_REPLY"}}
	client := pasteboard{open: func(_ context.Context, _ string) (xpcChannel, error) { return badSet, nil }}
	if _, err := client.set(ctx, textClipboard("staged"), okay); err == nil {
		t.Fatal("pasteboard.set ignored unreadable reply")
	}
	failedSet := &runtimeClipboard{current: clipboardSnapshot{items: textClipboard("original"), change: 9, hasChange: true}, setErrAfterSave: wire.Fail(wire.UnsupportedText)}
	err = pasteTransaction(ctx, failedSet, "staged", okay, func() error { inserted = true; return nil })
	failure(t, err, wire.UnsupportedText, "not-started")
	if inserted || failedSet.writes != 2 || !reflect.DeepEqual(failedSet.current.items, textClipboard("original")) {
		t.Fatalf("failed set reply skipped cleanup: inserted=%v writes=%d", inserted, failedSet.writes)
	}
}

func TestDisplayRefreshAndDemandDoNotBlockBehindPhoneLane(t *testing.T) {
	ctx := context.Background()
	screen, backend, _ := screenFixture(t)
	screen.backend = &runtimeScreen{fixtureScreen: backend}
	root, err := os.MkdirTemp("/tmp", "ib-fast-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(root) })
	m := NewManager(ctx, nil, nil)
	defer m.Close()
	m.rootPath = root
	session := &Session{screen: screen}
	phone := &localPhone{id: "fixture", binding: "binding", epoch: 1, session: session, entry: ios.DeviceEntry{DeviceID: 1}, lane: make(chan struct{}, 1), routeCtx: ctx}
	m.phones["fixture"] = phone
	var pipeline *fixtureMedia
	m.SetDisplayBackend(func(_ context.Context, _ *Session, cfg MediaPipelineConfig) (MediaPipeline, error) {
		pipeline = &fixtureMedia{cfg: cfg}
		return pipeline, nil
	}, nil, nil)

	ref := wire.DisplayRef{BindingToken: "binding", NativeEpoch: 1, StreamID: "dsp_c2a11f7c-8568-4d02-80ec-754ae26bb150"}
	if _, err := m.displayOperation(ctx, "display.start", &wire.DisplayStartParams{DisplayRef: ref, MaxLongSide: 1280, MaxFPS: 30}); err != nil {
		t.Fatal(err)
	}
	screen.display.cancelMonitor()
	<-screen.display.monitorDone

	// Hold p.lane (simulating an in-flight phone.observe) and verify refresh & demand complete immediately.
	phone.lane <- struct{}{}
	defer func() { <-phone.lane }()

	fastCtx, cancel := context.WithTimeout(ctx, 250*time.Millisecond)
	defer cancel()
	if _, err := m.displayOperation(fastCtx, "display.refresh", &ref); err != nil {
		t.Fatalf("display.refresh blocked or failed while lane was held: %v", err)
	}
	fps := 60
	if _, err := m.displayOperation(fastCtx, "display.demand", &wire.DisplayDemandParams{DisplayRef: ref, MaxFPS: &fps}); err != nil {
		t.Fatalf("display.demand blocked or failed while lane was held: %v", err)
	}
	if pipeline.refreshes != 1 || pipeline.profile[1] != 60 {
		t.Fatalf("expected refresh=1 and fps=60, got refreshes=%d profile=%v", pipeline.refreshes, pipeline.profile)
	}
}

func TestAppCacheServesWarmEntriesWithoutBlockingOnRefresh(t *testing.T) {
	life, cancel := context.WithCancel(context.Background())
	defer cancel()
	cache := &appCache{
		life: life,
		apps: []InstalledApp{{AppID: "com.example.app", Label: "Example"}},
		at:   time.Now().Add(-10 * time.Minute),
	}
	// Passing a blocking dialer verifies warm cache returns immediately while refreshing in background.
	start := time.Now()
	got, err := cache.read(context.Background(), stubSlowDialer{})
	if err != nil || len(got) != 1 || got[0].AppID != "com.example.app" {
		t.Fatalf("unexpected warm cache result: %+v, err=%v", got, err)
	}
	if time.Since(start) > 100*time.Millisecond {
		t.Fatalf("warm cache blocked for %v", time.Since(start))
	}
}

type stubSlowDialer struct{}

func (stubSlowDialer) DialService(ctx context.Context, _ string) (net.Conn, error) {
	<-ctx.Done()
	return nil, ctx.Err()
}
func (stubSlowDialer) OpenXPC(ctx context.Context, _ string) (*xpc.Connection, error) {
	return nil, errors.New("unused")
}
func (stubSlowDialer) Close() error { return nil }
