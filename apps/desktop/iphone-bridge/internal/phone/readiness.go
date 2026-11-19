package phone

import (
	"context"
	"github.com/steerlabs/opensteer/iphone-bridge/internal/wire"
)

const screenshotService = "com.apple.coredevice.screencaptureservice"
const hidService = "com.apple.coredevice.hid.indigo"
const appService = "com.apple.coredevice.appservice"
const inventoryService = "com.apple.mobile.installation_proxy.shim.remote"

func reasonPointer(reason wire.Reason) *wire.Reason {
	if reason == "" {
		return nil
	}
	return &reason
}
func unavailableCapabilities(reason wire.Reason) wire.Capabilities {
	return wire.Capabilities{Observe: reasonPointer(reason), Act: reasonPointer(reason), Launch: reasonPointer(reason), InstalledApps: reasonPointer(reason), Text: wire.UnsupportedText, Clear: wire.UnsupportedClear, IndexedTargets: wire.GeometryUnavailable, LiveVideo: wire.Unsupported}
}
func (s *Session) setDDIReason(reason wire.Reason) {
	s.mu.Lock()
	s.ddiReason = reason
	s.mu.Unlock()
}
func (s *Session) hasDDIReason() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.ddiReason != ""
}
func (s *Session) capabilities() wire.Capabilities {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return unavailableCapabilities(wire.PhoneDisconnected)
	}
	if !s.announced {
		return unavailableCapabilities(wire.NotInitialized)
	}
	if s.services.Udid != s.identity {
		return unavailableCapabilities(wire.IdentityMismatch)
	}
	missingReason := wire.ServiceMissing
	if s.ddiReason != "" {
		missingReason = s.ddiReason
	}
	available := func(unlocked bool, names ...string) *wire.Reason {
		for _, name := range names {
			if s.services.GetPort(name) < 1 {
				return reasonPointer(missingReason)
			}
		}
		if unlocked {
			if s.stateReason != "" {
				return reasonPointer(s.stateReason)
			}
			if err := s.state.safe(); err != nil {
				return reasonPointer(Classify(err, wire.LockUnknown).Code)
			}
		}
		return nil
	}
	result := unavailableCapabilities("")
	result.Observe = available(true, deviceInfoService, screenshotService)
	result.Act = available(true, deviceInfoService, hidService)
	if result.Act == nil && s.state.Rotation == nil {
		result.Act = reasonPointer(wire.GeometryUnavailable)
	}
	result.Launch = available(true, deviceInfoService, appService, inventoryService)
	result.InstalledApps = available(false, inventoryService)
	return result
}
func (s *Session) Probe(ctx context.Context) error {
	state, err := s.screenState().backend.State(ctx)
	s.mu.Lock()
	s.state = state
	s.stateReason = ""
	if err != nil {
		s.stateReason = Classify(err, wire.NativeServiceFailed).Code
	}
	s.mu.Unlock()
	return err
}
func (s *Session) stopControl() error {
	s.mu.Lock()
	screen := s.screen
	s.screen = nil
	s.mu.Unlock()
	if screen != nil {
		screen.close()
	}
	return nil
}

func (m *Manager) probe(ctx context.Context, token string) error {
	m.mu.Lock()
	p := m.findBinding(token)
	if p == nil {
		m.mu.Unlock()
		return wire.Fail(wire.NoSession)
	}
	ref := wire.PhoneRef{LocalPhoneID: p.id, NativeEpoch: p.epoch}
	m.mu.Unlock()
	_, err := m.withPhone(ctx, ref, func(ctx context.Context, p *localPhone) (interface{}, error) {
		var readinessReason wire.Reason
		s, err := m.ensureTransport(ctx, p)
		if err != nil {
			readinessReason = Classify(err, wire.NativeServiceFailed).Code
		} else {
			err = m.ensureDeveloperServices(ctx, p, s)
			if err != nil {
				if !s.hasDDIReason() {
					readinessReason = Classify(err, wire.NativeServiceFailed).Code
				}
			} else {
				err = s.Probe(ctx)
			}
		}
		m.mu.Lock()
		if p.epoch != ref.NativeEpoch || p.binding != token {
			m.mu.Unlock()
			return wire.Empty{}, wire.Fail(wire.StaleEpoch)
		}
		p.readinessReason = readinessReason
		m.revision++
		m.mu.Unlock()
		if m.publish != nil {
			m.publish(m.roster())
		}
		return wire.Empty{}, err
	})
	return err
}

func (m *Manager) ensureTransport(ctx context.Context, p *localPhone) (*Session, error) {
	m.mu.Lock()
	if p.session != nil {
		s := p.session
		m.mu.Unlock()
		return s, nil
	}
	epoch, binding := p.epoch, p.binding
	lifetime, cancel := context.WithCancel(m.ctx)
	m.mu.Unlock()
	session, err := m.openTransport(lifetime, ctx, p)
	if err != nil {
		cancel()
		return nil, err
	}
	m.mu.Lock()
	if p.binding != binding || p.epoch != epoch || lifetime.Err() != nil {
		m.mu.Unlock()
		cancel()
		_ = session.Close()
		return nil, wire.Fail(wire.StaleEpoch)
	}
	p.session, p.cancel = session, cancel
	m.mu.Unlock()
	if session.Done() != nil {
		go func() {
			<-session.Done()
			m.mu.Lock()
			if p.session == session {
				p.session, p.sessionID = nil, ""
				p.epoch++
				if p.routeCancel != nil {
					p.routeCancel()
				}
				p.routeCtx, p.routeCancel = context.WithCancel(m.ctx)
				m.revision++
			}
			m.mu.Unlock()
			m.wakeInspections()
			if m.publish != nil {
				m.publish(m.roster())
			}
		}()
	}
	return session, nil
}
