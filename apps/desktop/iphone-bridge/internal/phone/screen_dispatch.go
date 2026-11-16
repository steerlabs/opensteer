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
				return wire.Fail(wire.MediaRequired)
			}
			return nil
		}
		result, err := call(ctx, session.screenState(), guard)
		if observation, ok := result.(*Observation); ok {
			session.mu.Lock()
			session.state = observation.State
			session.stateReason = ""
			session.mu.Unlock()
		} else if err != nil && !control {
			session.mu.Lock()
			session.state = unknownState()
			session.stateReason = Classify(err, wire.NativeServiceFailed).Code
			session.mu.Unlock()
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
		current := map[string]bool{}
		for _, app := range apps {
			current[app.AppID] = true
		}
		allowed := map[string]bool{}
		if phone.appsEpoch == p.NativeEpoch {
			for id := range phone.apps {
				if current[id] {
					allowed[id] = true
				}
			}
		}
		for _, app := range result.Apps {
			allowed[app.AppID] = true
		}
		phone.apps = allowed
		phone.appsEpoch = p.NativeEpoch
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
			phone := m.findBinding(p.BindingToken)
			apps := map[string]bool{}
			if phone != nil && phone.appsEpoch == p.NativeEpoch {
				for id := range phone.apps {
					apps[id] = true
				}
			}
			var nativeSession *Session
			if phone != nil {
				nativeSession = phone.session
			}
			m.mu.Unlock()
			if nativeSession == nil {
				return nil, wire.Fail(wire.NoSession)
			}
			nativeGuard := guard
			guard = func() error {
				if err := nativeGuard(); err != nil {
					return err
				}
				for _, action := range p.Actions {
					switch action.Kind {
					case "tap", "longPress", "swipe", "drag", "navigate", "type", "clear":

						if !nativeSession.MediaReady() {
							return wire.Fail(wire.MediaRequired)
						}
					}
				}
				return nil
			}
			for _, action := range p.Actions {
				if action.Kind != "launch" {
					continue
				}
				inventory, err := readInstalledApps(ctx, nativeSession)
				if err != nil {
					return nil, err
				}
				current := map[string]bool{}
				for _, app := range inventory {
					current[app.AppID] = true
				}
				for id := range apps {
					if !current[id] {
						delete(apps, id)
					}
				}
				break
			}
			s.mu.Lock()
			s.apps = apps
			s.mu.Unlock()
			return s.perform(ctx, p, guard, waitDuration)
		})
	case *wire.AppsParams:
		return m.installedApps(ctx, p)
	}
	return nil, wire.Fail(wire.Unsupported)
}
