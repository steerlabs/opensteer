package phone

import (
	"context"

	"github.com/steerlabs/opensteer/iphone-bridge/internal/wire"
)

func (m *Manager) screenCall(ctx context.Context, ref wire.ScreenRef, control bool, call func(context.Context, *screenSession, func() error) (interface{}, error)) (interface{}, error) {
	return m.WithSession(ctx, ref.BindingToken, ref.SessionID, ref.NativeEpoch, control, func(ctx context.Context, session *Session) (interface{}, error) {
		guard := func() error {
			if err := ctx.Err(); err != nil {
				return Classify(err, wire.Cancelled)
			}
			m.mu.Lock()
			p := m.findBinding(ref.BindingToken)
			valid := !m.closed && p != nil && p.session == session && p.sessionID == ref.SessionID && p.epoch == ref.NativeEpoch
			access := ""
			if p != nil {
				access = p.access
			}
			m.mu.Unlock()
			if !valid {
				return wire.Fail(wire.StaleEpoch)
			}
			if control && access != "control" {
				return wire.Fail(wire.Unsupported)
			}
			return nil
		}
		result, err := call(ctx, session.screenState(), guard)
		switch observation := result.(type) {
		case *Observation:
			session.recordScreenState(observation.State, "")
		case *ScreenStatus:
			session.recordScreenState(observation.State, "")
		default:
			// Cancellation, stale geometry, and capture errors are call outcomes.
			// They do not establish a different lock or display state.
			return result, err
		}
		m.mu.Lock()
		m.revision++
		m.mu.Unlock()
		if m.publish != nil {
			m.publish(m.roster())
		}
		return result, err
	})
}
func (m *Manager) installedApps(ctx context.Context, p *wire.AppsParams) (interface{}, error) {
	m.mu.Lock()
	phone := m.findBinding(p.BindingToken)
	if phone == nil {
		m.mu.Unlock()
		return nil, wire.Fail(wire.NoSession)
	}
	ref := wire.PhoneRef{LocalPhoneID: phone.id, NativeEpoch: p.NativeEpoch}
	m.mu.Unlock()
	return m.withPhone(ctx, ref, func(ctx context.Context, phone *localPhone) (interface{}, error) {
		m.mu.Lock()
		valid := phone.binding == p.BindingToken
		m.mu.Unlock()
		if !valid {
			return nil, wire.Fail(wire.NoSession)
		}
		session, err := m.ensureTransport(ctx, phone)
		if err != nil {
			return nil, err
		}
		refreshed := false
		if !servicePresent(session, inventoryService) {
			if err := m.ensureDeveloperServices(ctx, phone, session); err != nil && !servicePresent(session, inventoryService) {
				return nil, err
			}
			refreshed = developerServicesPresent(session)
		}
		apps, err := readInstalledApps(ctx, session)
		if err != nil {
			return nil, err
		}
		result := pageApps(apps, p)
		m.mu.Lock()
		defer m.mu.Unlock()
		if phone.binding != p.BindingToken || phone.epoch != p.NativeEpoch || ctx.Err() != nil {
			return nil, wire.Fail(wire.StaleEpoch)
		}
		if refreshed {
			phone.readinessReason = ""
		}
		return result, nil
	})
}
func (m *Manager) screenOperation(ctx context.Context, params interface{}) (interface{}, error) {
	switch p := params.(type) {
	case *wire.ObserveParams:
		return m.screenCall(ctx, p.ScreenRef, false, func(ctx context.Context, s *screenSession, guard func() error) (interface{}, error) {
			return s.observe(ctx, p, guard)
		})
	case *wire.PerformParams:
		return m.screenCall(ctx, p.ScreenRef, true, func(ctx context.Context, s *screenSession, guard func() error) (interface{}, error) {
			m.mu.Lock()
			var nativeSession *Session
			if phone := m.findBinding(p.BindingToken); phone != nil {
				nativeSession = phone.session
			}
			m.mu.Unlock()
			if nativeSession == nil {
				return nil, wire.Fail(wire.NoSession)
			}
			// Any app installed right now may be launched; the agent needn't have listed it first.
			installed := map[string]bool{}
			for _, action := range p.Actions {
				if action.Kind != "launch" && action.Kind != "terminate" {
					continue
				}
				inventory, err := readInstalledApps(ctx, nativeSession)
				if err != nil {
					return nil, err
				}
				for _, app := range inventory {
					installed[app.AppID] = true
				}
				break
			}
			s.mu.Lock()
			s.apps = installed
			s.mu.Unlock()
			return s.perform(ctx, p, guard, waitDuration)
		})
	case *wire.AppsParams:
		return m.installedApps(ctx, p)
	}
	return nil, wire.Fail(wire.Unsupported)
}

func (m *Manager) displayOperation(ctx context.Context, method string, params interface{}) (interface{}, error) {
	var ref wire.DisplayRef
	switch p := params.(type) {
	case *wire.DisplayStartParams:
		ref = p.DisplayRef
	case *wire.DisplayDemandParams:
		ref = p.DisplayRef
	case *wire.DisplayInputParams:
		ref = p.DisplayRef
	case *wire.DisplayPowerParams:
		ref = p.DisplayRef
	case *wire.DisplayRef:
		ref = *p
	default:
		return nil, wire.Fail(wire.ProtocolUnsupported)
	}
	m.mu.Lock()
	phone := m.findBinding(ref.BindingToken)
	local := wire.PhoneRef{NativeEpoch: ref.NativeEpoch}
	if phone != nil {
		local.LocalPhoneID = phone.id
	}
	factory, publish, root := m.mediaFactory, m.publishDisplay, m.rootPath
	m.mu.Unlock()
	// Non-blocking display control operations (refresh, demand, inputReset, stop)
	// operate solely on displaySession/pipeline/inputMu and must never serialize
	// behind a slow agent observe/perform on p.lane.
	if method == "display.refresh" || method == "display.demand" || method == "display.inputReset" || method == "display.stop" {
		m.mu.Lock()
		var session *Session
		valid := !m.closed && phone != nil && phone.entry.DeviceID != 0 && phone.epoch == ref.NativeEpoch && phone.binding == ref.BindingToken
		if valid {
			session = phone.session
		}
		m.mu.Unlock()
		if !valid {
			if phone == nil {
				return nil, wire.Fail(wire.NoSession)
			}
			return nil, wire.Fail(wire.StaleEpoch)
		}
		if session == nil {
			if method == "display.stop" || method == "display.inputReset" {
				return wire.Empty{}, nil
			}
			return nil, wire.Fail(wire.NoSession)
		}
		s := session.screenState()
		if method == "display.inputReset" || method == "display.stop" {
			s.abortOwnerBatch(ref, method == "display.stop")
		}
		s.displayMu.Lock()
		d := s.display
		match := d != nil && d.ref == ref
		if match {
			if p, ok := params.(*wire.DisplayDemandParams); ok {
				if p.MaxLongSide != nil {
					d.config.MaxLongSide = *p.MaxLongSide
				}
				if p.MaxFPS != nil {
					d.config.MaxFPS = *p.MaxFPS
				}
				maxLongSide, maxFPS := d.config.MaxLongSide, d.config.MaxFPS
				pipeline := d.pipeline
				s.displayMu.Unlock()
				pipeline.UpdateDemand(maxLongSide, maxFPS)
				return wire.Empty{}, nil
			}
			if method == "display.refresh" {
				pipeline := d.pipeline
				s.displayMu.Unlock()
				pipeline.RequestKeyframe()
				return wire.Empty{}, nil
			}
		}
		s.displayMu.Unlock()
		if !match {
			if method == "display.stop" || method == "display.inputReset" {
				return wire.Empty{}, nil
			}
			return nil, wire.Fail(wire.StaleEpoch)
		}
		switch method {
		case "display.stop":
			return wire.Empty{}, s.stopDisplay(&ref)
		case "display.inputReset":
			return wire.Empty{}, s.resetOwnerInput()
		}
		return wire.Empty{}, nil
	}
	call := func(ctx context.Context, phone *localPhone) (interface{}, error) {
		m.mu.Lock()
		session := phone.session
		route := phone.routeCtx
		valid := phone.binding == ref.BindingToken
		m.mu.Unlock()
		if !valid {
			return nil, wire.Fail(wire.StaleEpoch)
		}
		var err error
		if method == "display.start" && session == nil {
			if factory == nil {
				return nil, wire.Fail(wire.Unsupported)
			}
			session, err = m.ensureTransport(ctx, phone)
			if err != nil {
				return nil, err
			}
			if err = m.ensureDeveloperServices(ctx, phone, session); err != nil {
				return nil, err
			}
		}
		if session == nil {
			return nil, wire.Fail(wire.NoSession)
		}
		fence := func() error {
			m.mu.Lock()
			defer m.mu.Unlock()
			if m.closed || phone.epoch != ref.NativeEpoch || phone.binding != ref.BindingToken || phone.session != session {
				return wire.Fail(wire.StaleEpoch)
			}
			return nil
		}
		s := session.screenState()
		s.mu.Lock()
		closed := s.closed
		s.mu.Unlock()
		if closed {
			return nil, wire.Fail(wire.NoSession)
		}
		guard := func() error {
			if err := ctx.Err(); err != nil {
				return err
			}
			return fence()
		}
		if err := guard(); err != nil {
			return nil, err
		}
		if p, ok := params.(*wire.DisplayStartParams); ok {
			return s.startDisplay(ctx, p, session, route, root, factory, publish, guard, fence)
		}
		s.displayMu.Lock()
		d := s.display
		match := d != nil && d.ref == ref
		s.displayMu.Unlock()
		if !match {
			return nil, wire.Fail(wire.StaleEpoch)
		}
		switch p := params.(type) {
		case *wire.DisplayInputParams:
			return wire.Empty{}, s.displayInput(ctx, d, p.Geometry, p.Events, guard, waitDuration)
		case *wire.DisplayPowerParams:
			state, err := s.backend.State(ctx)
			if err != nil {
				s.hideDisplay("protected", "target-unavailable")
				return nil, err
			}
			f, fgKnown := s.foregroundChecked(ctx)
			s.applyPrivacy(state, f, fgKnown)
			if f != nil && f.AppID == opensteerAppID {
				return nil, wire.Fail(wire.Unsupported)
			}
			s.invalidateObservation()
			return wire.Empty{}, s.setPower(ctx, state, p.Action, guard, waitDuration)
		}
		return wire.Empty{}, nil
	}
	var result interface{}
	err := error(wire.Fail(wire.NoSession))
	if phone != nil {
		result, err = m.withPhone(ctx, local, call)
	}
	if method == "display.input" || method == "display.power" {
		return refusal(err, method == "display.power"), nil
	}
	return result, err
}
