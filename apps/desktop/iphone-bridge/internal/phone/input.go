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
	s.mu.Unlock()
	if o == nil || o.ObservationToken != p.ObservationToken || o.NativeEpoch != p.NativeEpoch || o.GeometryRevision != p.GeometryRevision {
		return nil, wire.Fail(wire.StaleObservation)
	}
	resolved := make([]wire.Point, len(p.Actions))
	duration := time.Duration(0)
	for i, a := range p.Actions {
		switch a.Kind {
		case "type":
			return nil, wire.Fail(wire.UnsupportedText)
		case "clear":
			return nil, wire.Fail(wire.UnsupportedClear)
		case "tap", "longPress", "swipe", "drag":
			if a.Target == nil || a.Target.Point == nil {
				return nil, wire.Fail(wire.GeometryUnavailable)
			}
			resolved[i], err = o.Geometry.Normalize(*a.Target.Point)
			if err != nil {
				return nil, err
			}
			if a.To != nil {
				if _, err = o.Geometry.Normalize(*a.To); err != nil {
					return nil, err
				}
			}
		case "launch":
			s.mu.Lock()
			found := s.apps[a.AppID]
			s.mu.Unlock()
			if !found {
				return nil, wire.Fail(wire.AppUnavailable)
			}
		case "wake":
			if o.State.Display != "on" {
				return nil, wire.Fail(wire.WakeRequired)
			}
		case "navigate":
			if a.Button != "home" && a.Button != "lock" && a.Button != "volumeUp" && a.Button != "volumeDown" {
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
		check := func() error {
			if err := ctx.Err(); err != nil {
				return Classify(err, wire.Cancelled)
			}
			return guard()
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
			return fail(err)
		}
		if err = state.safe(); err != nil {
			return fail(err)
		}
		if !state.same(o.State) {
			return fail(wire.Fail(wire.StaleObservation))
		}
		if a.Kind == "wake" {
			result.CompletedSteps++
			continue
		}
		if a.Kind == "launch" {
			if err := s.backend.Launch(ctx, a.AppID, check); err != nil {
				return fail(err)
			}
			result.Effect = "submitted"
			result.CompletedSteps++
			continue
		}
		conn, close, err := openInput(ctx, s.backend)
		if err != nil {
			return fail(err)
		}
		if a.Kind == "navigate" {
			err = pressButton(ctx, conn, a.Button, check, wait)
		} else {
			err = gesture(ctx, conn, o.Geometry, resolved[i], a, check, wait)
		}
		close()
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
func openInput(ctx context.Context, b screenBackend) (xpcChannel, func(), error) {
	life, cancel := context.WithTimeout(context.WithoutCancel(ctx), 30500*time.Millisecond)
	if d, ok := ctx.Deadline(); ok {
		cancel()
		life, cancel = context.WithDeadline(context.WithoutCancel(ctx), d.Add(500*time.Millisecond))
	}
	stop := context.AfterFunc(ctx, cancel)
	conn, err := b.HID(life)
	stop()
	if err != nil {
		cancel()
		return nil, nil, err
	}
	done, joined := make(chan struct{}), make(chan struct{})
	go func() {
		defer close(joined)
		select {
		case <-done:
			return
		case <-ctx.Done():
		}
		timer := time.NewTimer(500 * time.Millisecond)
		defer timer.Stop()
		select {
		case <-done:
		case <-timer.C:
			cancel()
		}
	}()
	input := &gracefulInput{xpcChannel: conn, wait: waitDuration}
	return input, func() { _ = input.Close(); close(done); cancel(); <-joined }, nil
}
func digitizerPayload(phase uint64, p wire.Point, display uint64) map[string]interface{} {
	return map[string]interface{}{"featureIdentifier": "com.apple.coredevice.feature.remote.hid.digitizer", "messageType": "IndigoDigitizerEvent", "payload": map[string]interface{}{"pointOne": map[string]interface{}{"x": p.X, "y": p.Y}, "eventType": phase, "edge": uint64(0), "target": display}}
}
func gesture(ctx context.Context, c xpcChannel, g Geometry, start wire.Point, a wire.Action, check func() error, wait pause) (err error) {
	held := false
	last := start
	send := func(phase uint64, p wire.Point) error {
		return c.Send(digitizerPayload(phase, p, g.DisplayID), xpc.HeartbeatRequestFlag)
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
func buttonPayload(usage, state uint64) map[string]interface{} {
	return map[string]interface{}{"featureIdentifier": "com.apple.coredevice.feature.remote.hid.button", "messageType": "IndigoButtonEvent", "payload": map[string]interface{}{"usagePage": uint64(12), "usageCode": usage, "state": state}}
}
func pressButton(ctx context.Context, c xpcChannel, button string, check func() error, wait pause) (err error) {
	usage := map[string]uint64{"home": 0x40, "lock": 0x30, "volumeUp": 0xe9, "volumeDown": 0xea}[button]
	if usage == 0 {
		return wire.Fail(wire.Unsupported)
	}
	held := false
	defer func() {
		if held {
			if e := c.Send(buttonPayload(usage, 2), xpc.HeartbeatRequestFlag); e != nil {
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
	if err = c.Send(buttonPayload(usage, 1), xpc.HeartbeatRequestFlag); err != nil {
		return &wire.Failure{Code: wire.OutcomeUnknown, Effect: "unknown"}
	}
	hold := 250 * time.Millisecond
	if button == "home" {
		hold = time.Millisecond
	}
	if err = wait(ctx, hold); err != nil {
		return err
	}
	if err = check(); err != nil {
		return err
	}
	err = c.Send(buttonPayload(usage, 2), xpc.HeartbeatRequestFlag)
	if err != nil {
		return &wire.Failure{Code: wire.OutcomeUnknown, Effect: "unknown"}
	}
	held = false
	return nil
}

const inputCloseGrace = 250 * time.Millisecond

// Indigo has no acknowledgement; closing immediately after an up event loses it.
type gracefulInput struct {
	xpcChannel
	lastSend time.Time
	wait     pause
}

func (c *gracefulInput) Send(m map[string]interface{}, flags ...uint32) error {
	err := c.xpcChannel.Send(m, flags...)
	c.lastSend = time.Now()
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
