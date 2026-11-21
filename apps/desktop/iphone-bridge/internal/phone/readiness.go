package phone

import (
	"context"
	"log/slog"

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
	return wire.Capabilities{Observe: reasonPointer(reason), Act: reasonPointer(reason), Launch: reasonPointer(reason), InstalledApps: reasonPointer(reason), Text: reasonPointer(wire.UnsupportedText), Clear: reasonPointer(wire.UnsupportedClear), IndexedTargets: reasonPointer(wire.GeometryUnavailable), LiveVideo: reasonPointer(wire.Unsupported), Wake: reasonPointer(reason)}
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
			return reasonPointer(s.state.screenBlocker())
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
	result.Text = available(true, deviceInfoService, hidService, pasteboardService, deviceHubAXService)
	result.Clear = available(true, deviceInfoService, hidService, deviceHubAXService)
	result.IndexedTargets = result.Act
	if result.IndexedTargets == nil && s.services.GetPort(deviceHubAXService) < 1 && s.visionOCR == nil {
		result.IndexedTargets = reasonPointer(wire.GeometryUnavailable)
	}
	if s.mediaAvailable {
		// Opening a Live View stream stays available while sleeping or locked so a
		// person can open a shielded view and wake the phone; pixels remain withheld
		// until displayPrivacy sees an unlocked, awake, non-Opensteer screen.
		result.LiveVideo = available(false, deviceInfoService, DisplayService)
	}
	result.Wake = available(false, deviceInfoService, hidService)
	if result.Wake == nil {
		switch {
		case s.stateReason != "":
			result.Wake = reasonPointer(s.stateReason)
		case s.state.Display != "on" && s.state.Display != "off":
			result.Wake = reasonPointer(wire.DisplayUnknown)
		}
	}
	return result
}
func (s *Session) Probe(ctx context.Context) error {
	state, err := s.screenState().backend.State(ctx)
	if ctx.Err() != nil {
		return ctx.Err()
	}
	var reason wire.Reason
	if err != nil {
		reason = Classify(err, wire.NativeServiceFailed).Code
	}
	s.recordScreenState(state, reason)
	return err
}

func (s *Session) recordScreenState(state DeviceState, reason wire.Reason) {
	s.mu.Lock()
	changed := s.state.Lock != state.Lock || s.state.Display != state.Display || s.stateReason != reason
	s.state, s.stateReason = state, reason
	screen := s.screen
	s.mu.Unlock()
	if screen != nil && (reason != "" || state.screenBlocker() != "") {
		if state.Display == "off" {
			screen.hideDisplay("screen-off", "locked-screen")
		} else {
			screen.hideDisplay("protected", "locked-screen")
		}
	}
	if changed {
		if reason == "" {
			reason = state.screenBlocker()
		}
		slog.Debug("bridge.screen-state", "lock", state.Lock, "display", state.Display, "reason", string(reason))
	}
}
func (s *Session) stopControl() error {
	s.mu.Lock()
	screen := s.screen
	s.mu.Unlock()
	if screen != nil {
		screen.closeAgent()
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
	session.mediaAvailable, session.visionOCR = m.mediaFactory != nil, m.visionOCR
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
			_ = session.Close()
			m.wakeInspections()
			if m.publish != nil {
				m.publish(m.roster())
			}
		}()
	}
	return session, nil
}
