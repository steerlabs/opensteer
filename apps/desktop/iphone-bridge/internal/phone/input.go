package phone

import (
	"context"
	"errors"
	"time"

	"github.com/danielpaulus/go-ios/ios/xpc"
	"github.com/steerlabs/opensteer/iphone-bridge/internal/wire"
)

type PerformResult struct {
	Effect              string `json:"effect"`
	CompletedSteps      int    `json:"completedSteps"`
	ObservationRequired bool   `json:"observationRequired"`
}

func (r PerformResult) EffectFailure(code wire.Reason) *wire.Failure {
	return &wire.Failure{Code: code, Effect: r.Effect, CompletedSteps: r.CompletedSteps}
}

type pause func(context.Context, time.Duration) error

func waitDuration(ctx context.Context, d time.Duration) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}
func (s *screenSession) perform(ctx context.Context, p *wire.PerformParams, guard func() error, wait pause) (interface{}, error) {
	ctx, finish, err := s.begin(ctx)
	if err != nil {
		return nil, err
	}
	defer finish()
	s.mu.Lock()
	o := s.observation
	wakeRef := s.wakeRef
	s.mu.Unlock()
	wakeOnly := len(p.Actions) == 1 && p.Actions[0].Kind == "wake"
	if o == nil && wakeOnly && wakeRef != nil && wakeRef.ScreenRef == p.ScreenRef && wakeRef.ObservationToken == p.ObservationToken && wakeRef.GeometryRevision == p.GeometryRevision {
		o = &Observation{ObservationToken: wakeRef.ObservationToken, NativeEpoch: wakeRef.NativeEpoch, GeometryRevision: wakeRef.GeometryRevision}
	}
	if o == nil || o.ObservationToken != p.ObservationToken || o.NativeEpoch != p.NativeEpoch || o.GeometryRevision != p.GeometryRevision {
		return nil, wire.Fail(wire.StaleObservation)
	}
	resolved := make([]wire.Point, len(p.Actions))
	duration := time.Duration(0)
	for i, a := range p.Actions {
		switch a.Kind {
		case "type", "clear":
			if _, ok := s.backend.(editingBackend); !ok {
				reason := wire.UnsupportedText
				if a.Kind == "clear" {
					reason = wire.UnsupportedClear
				}
				return nil, wire.Fail(reason)
			}
			if a.Target == nil {
				break
			}
			fallthrough
		case "tap", "longPress", "swipe", "drag", "pinch":
			resolved[i], err = targetPoint(o, a.Target)
			if err != nil {
				return nil, err
			}
			if a.To != nil {
				if _, err = o.Geometry.Normalize(*a.To); err != nil {
					return nil, err
				}
			}
		case "launch", "terminate":
			if a.AppID == opensteerAppID {
				return nil, wire.Fail(wire.Unsupported)
			}
			s.mu.Lock()
			found := s.apps[a.AppID]
			s.mu.Unlock()
			if !found {
				return nil, wire.Fail(wire.AppUnavailable)
			}
		case "wake":
		case "key":
			if _, ok := keyChord(a.Key, a.Modifiers); !ok {
				return nil, wire.Fail(wire.UnsupportedText)
			}
		case "navigate":
			if !wire.ValidButton(a.Button) {
				return nil, wire.Fail(wire.Unsupported)
			}
		case "wait":
		default:
			return nil, wire.Fail(wire.Unsupported)
		}
		duration += time.Duration(a.DurationMs+a.HoldMs) * time.Millisecond
	}
	if deadline, ok := ctx.Deadline(); ok && time.Until(deadline) < duration+time.Second {
		return nil, wire.Fail(wire.DeadlineExceeded)
	}
	if err = guard(); err != nil {
		return nil, err
	}
	s.mu.Lock()
	s.observation = nil
	s.wakeRef = nil
	s.mu.Unlock()
	result := PerformResult{Effect: "not-started", ObservationRequired: true}
	fail := func(err error) (interface{}, error) {
		f := Classify(err, wire.NativeServiceFailed)
		if f.Effect == "not-started" {
			f = &wire.Failure{Code: f.Code, Effect: result.Effect}
		}
		f.CompletedSteps = result.CompletedSteps
		return nil, f
	}
	for i, a := range p.Actions {
		var view *displaySession
		var visibleAfter time.Time
		check := func() error {
			if err := ctx.Err(); err != nil {
				return Classify(err, wire.Cancelled)
			}
			if err := guard(); err != nil {
				return err
			}
			if view != nil {
				s.displayMu.Lock()
				defer s.displayMu.Unlock()
				if s.display != view || view.hidden != "" || view.visibleAfter != visibleAfter {
					return wire.Fail(wire.StaleObservation)
				}
			}
			return nil
		}
		if err := check(); err != nil {
			return fail(err)
		}
		if a.Kind == "wait" {
			if err := wait(ctx, time.Duration(a.DurationMs)*time.Millisecond); err != nil {
				return fail(err)
			}
			result.CompletedSteps++
			continue
		}
		state, err := s.backend.State(ctx)
		if err != nil {
			s.hideDisplay("protected", "target-unavailable")
			return fail(err)
		}
		foreground := s.foreground(ctx)
		s.applyPrivacy(state, foreground)
		if foreground != nil && foreground.AppID == opensteerAppID {
			return fail(wire.Fail(wire.Unsupported))
		}
		if a.Kind == "wake" {
			if state.Display != "on" {
				if err := s.setPower(ctx, state, "wake", check, wait); err != nil {
					return fail(err)
				}
				result.Effect = "submitted"
			}
			result.CompletedSteps++
			continue
		}
		if err = state.safe(); err != nil {
			return fail(err)
		}
		if !state.same(o.State) {
			return fail(wire.Fail(wire.StaleObservation))
		}
		if s.ownerInputHeld() {
			return fail(wire.Fail(wire.PhoneInUse))
		}
		if a.Kind != "navigate" || a.Button != "lock" {
			s.displayMu.Lock()
			view = s.display
			if view != nil {
				visibleAfter = view.visibleAfter
			}
			s.displayMu.Unlock()
			if view != nil {
				if err := check(); err != nil {
					return fail(err)
				}
			}
		}
		switch a.Kind {
		case "launch":
			err = s.backend.Launch(ctx, a.AppID, check)
		case "terminate":
			if backend, ok := s.backend.(interface {
				Terminate(context.Context, string, func() error) error
			}); ok {
				err = backend.Terminate(ctx, a.AppID, check)
			} else {
				err = wire.Fail(wire.Unsupported)
			}
		case "type", "clear":
			if a.Target != nil {
				err = s.withInput(ctx, func(c xpcChannel) error {
					return gesture(ctx, c, o.Geometry, resolved[i], wire.Action{Kind: "tap"}, check, wait)
				})
				if err != nil {
					return fail(err)
				}
				result.Effect = "submitted"
			}
			if a.Kind == "type" {
				err = s.typeText(ctx, *a.Text, a.Submit != nil && *a.Submit, check)
			} else {
				err = s.clearField(ctx, check)
			}
		case "key":
			_, err = s.readFocus(ctx)
			if err == nil || err == errNoField {
				err = s.pressKey(ctx, a.Key, a.Modifiers, check)
			}
		default:
			if a.Kind == "navigate" && a.Button == "lock" {
				err = s.setPower(ctx, state, "lock", check, wait)
				break
			}
			err = s.withInput(ctx, func(c xpcChannel) error {
				if a.Kind == "navigate" {
					return navigate(ctx, c, o.Geometry, a.Button, check, wait)
				}
				return gesture(ctx, c, o.Geometry, resolved[i], a, check, wait)
			})
		}
		if err != nil {
			return fail(err)
		}
		result.Effect = "submitted"
		result.CompletedSteps++
	}
	if err := ctx.Err(); err != nil {
		return fail(err)
	}
	return result, nil
}

// withInput serializes input and keeps the Indigo socket alive across requests.
func (s *screenSession) withInput(ctx context.Context, run func(xpcChannel) error) error {
	s.inputMu.Lock()
	defer s.inputMu.Unlock()
	if err := ctx.Err(); err != nil {
		return err
	}
	if s.input == nil {
		life, cancel := context.WithCancel(context.WithoutCancel(ctx))
		stop := context.AfterFunc(ctx, cancel)
		conn, err := s.backend.HID(life)
		stop()
		if err != nil {
			cancel()
			return err
		}
		if life.Err() != nil || ctx.Err() != nil {
			_ = conn.Close()
			cancel()
			return ctx.Err()
		}
		s.input = &gracefulInput{xpcChannel: conn, wait: waitDuration}
		s.cancelInput = cancel
	}
	cancel := s.cancelInput
	finished := make(chan struct{})
	defer close(finished)
	stop := context.AfterFunc(ctx, func() {
		_ = waitDuration(context.Background(), 500*time.Millisecond)
		select {
		case <-finished:
		default:
			cancel()
		}
	})
	defer stop()
	err := run(s.input)
	if s.input.failed || ctx.Err() != nil {
		s.closeInputLocked()
	}
	return err
}

func (s *screenSession) closeInputLocked() {
	if s.input != nil {
		_ = s.resetOwnerInputLocked()
		_ = s.input.Close()
		s.cancelInput()
		s.input, s.cancelInput = nil, nil
	}
}

func (s *screenSession) closeInput() {
	s.inputMu.Lock()
	defer s.inputMu.Unlock()
	s.closeInputLocked()
}

func digitizerPayload(phase uint64, p wire.Point, display, edge uint64, second *wire.Point) map[string]interface{} {
	payload := map[string]interface{}{"pointOne": map[string]interface{}{"x": p.X, "y": p.Y}, "eventType": phase, "edge": edge, "target": display}
	if second != nil {
		payload["pointTwo"] = map[string]interface{}{"x": second.X, "y": second.Y}
	}
	return map[string]interface{}{"featureIdentifier": "com.apple.coredevice.feature.remote.hid.digitizer", "messageType": "IndigoDigitizerEvent", "payload": payload}
}
func gesture(ctx context.Context, c xpcChannel, g Geometry, start wire.Point, a wire.Action, check func() error, wait pause) (err error) {
	if a.Kind == "tap" && a.Count == 2 {
		a.Count = 1
		if err := gesture(ctx, c, g, start, a, check, wait); err != nil {
			return err
		}
		if err := wait(ctx, 80*time.Millisecond); err != nil {
			return submittedError(err)
		}
		return submittedError(gesture(ctx, c, g, start, a, check, wait))
	}
	if a.Kind == "pinch" {
		return pinch(ctx, c, g, start, a, check, wait)
	}
	held := false
	last := start
	edge := uint64(0)
	if a.Kind == "swipe" {
		edge = swipeEdge(a.Edge, start, g.Rotation)
	}
	send := func(phase uint64, p wire.Point) error {
		return c.Send(digitizerPayload(phase, p, g.DisplayID, edge, nil), xpc.HeartbeatRequestFlag)
	}
	defer func() {
		if held {
			releaseErr := send(2, last)
			if releaseErr != nil {
				err = &wire.Failure{Code: wire.OutcomeUnknown, Effect: "unknown"}
			}
		}
		if err != nil && held {
			var f *wire.Failure
			if !errors.As(err, &f) || f.Effect == "not-started" {
				err = &wire.Failure{Code: Classify(err, wire.NativeServiceFailed).Code, Effect: "submitted"}
			}
		}
	}()
	if err = check(); err != nil {
		return err
	}
	// Mark held before sending: a short/failed write can still put the contact down.
	held = true
	if err = send(0, start); err != nil {
		return &wire.Failure{Code: wire.OutcomeUnknown, Effect: "unknown"}
	}
	if a.HoldMs > 0 {
		if err = wait(ctx, time.Duration(a.HoldMs)*time.Millisecond); err != nil {
			return err
		}
	}
	if a.To != nil {
		to, e := g.Normalize(*a.To)
		if e != nil {
			return e
		}
		steps := min(120, max(1, a.DurationMs/16))
		interval := time.Duration(a.DurationMs) * time.Millisecond / time.Duration(steps)
		for i := 1; i <= steps; i++ {
			if err = wait(ctx, interval); err != nil {
				return err
			}
			if err = check(); err != nil {
				return err
			}
			t := float64(i) / float64(steps)
			last = wire.Point{X: start.X + (to.X-start.X)*t, Y: start.Y + (to.Y-start.Y)*t}
			if err = send(1, last); err != nil {
				return &wire.Failure{Code: wire.OutcomeUnknown, Effect: "unknown"}
			}
		}
	} else {
		hold := time.Duration(a.DurationMs) * time.Millisecond
		if hold == 0 {
			hold = 40 * time.Millisecond
		}
		if err = wait(ctx, hold); err != nil {
			return err
		}
	}
	if err = check(); err != nil {
		return err
	}
	if err = send(2, last); err != nil {
		return &wire.Failure{Code: wire.OutcomeUnknown, Effect: "unknown"}
	}
	held = false
	return nil
}
func buttonPayload(page, usage, state uint64) map[string]interface{} {
	return map[string]interface{}{"featureIdentifier": "com.apple.coredevice.feature.remote.hid.button", "messageType": "IndigoButtonEvent", "payload": map[string]interface{}{"usagePage": page, "usageCode": usage, "state": state}}
}
func pressButton(ctx context.Context, c xpcChannel, button string, check func() error, wait pause) (err error) {
	page := uint64(0x0c)
	usage := map[string]uint64{"home": 0x40, "lock": 0x30, "volumeUp": 0xe9, "volumeDown": 0xea, "action": 0x2d, "siri": 0xcf}[button]
	if button == "action" {
		page = 0x0b
	}
	if usage == 0 {
		return wire.Fail(wire.Unsupported)
	}
	held := false
	defer func() {
		if held {
			if e := c.Send(buttonPayload(page, usage, 2), xpc.HeartbeatRequestFlag); e != nil {
				err = &wire.Failure{Code: wire.OutcomeUnknown, Effect: "unknown"}
			}
			if err != nil {
				f := Classify(err, wire.NativeServiceFailed)
				if f.Effect == "not-started" {
					err = &wire.Failure{Code: f.Code, Effect: "submitted"}
				}
			}
		}
	}()
	if err = check(); err != nil {
		return err
	}
	held = true
	if err = c.Send(buttonPayload(page, usage, 1), xpc.HeartbeatRequestFlag); err != nil {
		return &wire.Failure{Code: wire.OutcomeUnknown, Effect: "unknown"}
	}
	hold := 50 * time.Millisecond
	switch button {
	case "home":
		hold = time.Millisecond
	case "action", "siri":
		hold = time.Second
	}
	if err = wait(ctx, hold); err != nil {
		return err
	}
	if err = check(); err != nil {
		return err
	}
	err = c.Send(buttonPayload(page, usage, 2), xpc.HeartbeatRequestFlag)
	if err != nil {
		return &wire.Failure{Code: wire.OutcomeUnknown, Effect: "unknown"}
	}
	held = false
	return nil
}

type boundedHID struct {
	xpcChannel
	deadline func(time.Time) error
}

func (c boundedHID) Send(payload map[string]interface{}, flags ...uint32) error {
	if err := c.deadline(time.Now().Add(500 * time.Millisecond)); err != nil {
		return err
	}
	defer c.deadline(time.Time{})
	return c.xpcChannel.Send(payload, flags...)
}

const inputCloseGrace = 250 * time.Millisecond

// Indigo has no acknowledgement; closing immediately after an up event loses it.
type gracefulInput struct {
	xpcChannel
	lastSend time.Time
	failed   bool
	wait     pause
}

func (c *gracefulInput) Send(m map[string]interface{}, flags ...uint32) error {
	err := c.xpcChannel.Send(m, flags...)
	c.lastSend = time.Now()
	c.failed = c.failed || err != nil
	return err
}
func (c *gracefulInput) Close() error {
	if !c.lastSend.IsZero() {
		if remaining := inputCloseGrace - time.Since(c.lastSend); remaining > 0 {
			_ = c.wait(context.Background(), remaining)
		}
	}
	return c.xpcChannel.Close()
}

func submittedError(err error) error {
	if err == nil {
		return nil
	}
	f := Classify(err, wire.NativeServiceFailed)
	if f.Effect == "not-started" {
		return &wire.Failure{Code: f.Code, Effect: "submitted"}
	}
	return err
}

// The start point is already in the digitizer's (rotated) coordinate space.
func swipeEdge(edge string, start wire.Point, rotation *int) uint64 {
	if edge == "" {
		distances := []float64{start.Y, start.X, 1 - start.Y, 1 - start.X}
		result, best := uint64(0), 0.02
		for i, distance := range distances {
			if distance <= best && (result == 0 || distance < best) {
				result, best = uint64(i+1), distance
			}
		}
		return result
	}
	value := map[string]int{"top": 0, "left": 1, "bottom": 2, "right": 3}
	index, ok := value[edge]
	if !ok || rotation == nil {
		return 0
	}
	return uint64((index+*rotation/90)%4 + 1)
}

func pinch(ctx context.Context, c xpcChannel, g Geometry, center wire.Point, a wire.Action, check func() error, wait pause) (err error) {
	// Choose the axis with more room so both contacts stay inside the display.
	marginX, marginY := min(center.X, 1-center.X), min(center.Y, 1-center.Y)
	radius := min(0.2, max(marginX, marginY)*0.95)
	if radius < 0.001 {
		return wire.Fail(wire.GeometryUnavailable)
	}
	start, end := radius/max(1, a.Scale), radius*min(1, a.Scale)
	send := func(phase uint64, distance float64) error {
		first, second := center, center
		if marginX >= marginY {
			first.X -= distance
			second.X += distance
		} else {
			first.Y -= distance
			second.Y += distance
		}
		if err := c.Send(digitizerPayload(phase, first, g.DisplayID, 0, &second), xpc.HeartbeatRequestFlag); err != nil {
			return &wire.Failure{Code: wire.OutcomeUnknown, Effect: "unknown"}
		}
		return nil
	}
	if err := check(); err != nil {
		return err
	}
	last := start
	defer func() {
		if release := send(2, last); release != nil {
			err = release
		} else {
			err = submittedError(err)
		}
	}()
	if err := send(0, last); err != nil {
		return err
	}
	steps := min(120, max(1, a.DurationMs/16))
	for i := 1; i <= steps; i++ {
		if err := wait(ctx, time.Duration(a.DurationMs)*time.Millisecond/time.Duration(steps)); err != nil {
			return err
		}
		if err := check(); err != nil {
			return err
		}
		last = start + (end-start)*float64(i)/float64(steps)
		if err := send(1, last); err != nil {
			return err
		}
	}
	return nil
}

func displayGesture(ctx context.Context, c xpcChannel, g Geometry, start, end wire.Point, edge string, check func() error, wait pause) error {
	pixel := func(p wire.Point) wire.Point {
		return wire.Point{X: p.X * float64(g.Width-1), Y: p.Y * float64(g.Height-1)}
	}
	from, err := g.Normalize(pixel(start))
	if err != nil {
		return err
	}
	to := pixel(end)
	return gesture(ctx, c, g, from, wire.Action{Kind: "swipe", To: &to, DurationMs: 220, Edge: edge}, check, wait)
}

func navigate(ctx context.Context, c xpcChannel, g Geometry, button string, check func() error, wait pause) error {
	switch button {
	case "recents":
		if err := pressButton(ctx, c, "home", check, wait); err != nil {
			return err
		}
		if err := wait(ctx, 150*time.Millisecond); err != nil {
			return submittedError(err)
		}
		return submittedError(pressButton(ctx, c, "home", check, wait))
	case "notifications", "quickSettings":
		x := 0.15
		if button == "quickSettings" {
			x = 0.9
		}
		return displayGesture(ctx, c, g, wire.Point{X: x, Y: 0.005}, wire.Point{X: x, Y: 0.55}, "top", check, wait)
	case "back":
		return displayGesture(ctx, c, g, wire.Point{X: 0.005, Y: 0.5}, wire.Point{X: 0.65, Y: 0.5}, "left", check, wait)
	default:
		return pressButton(ctx, c, button, check, wait)
	}
}

func targetPoint(o *Observation, target *wire.Target) (wire.Point, error) {
	if target != nil && target.Point != nil {
		return o.Geometry.Normalize(*target.Point)
	}
	if target != nil && o.Coverage.CoordinateSpace == "qualified" {
		for _, node := range o.Nodes {
			if node.NodeID == target.NodeID && node.Frame != nil {
				frame := node.Frame
				return o.Geometry.Normalize(wire.Point{X: frame.X + frame.Width/2, Y: frame.Y + frame.Height/2})
			}
		}
	}
	return wire.Point{}, wire.Fail(wire.GeometryUnavailable)
}
