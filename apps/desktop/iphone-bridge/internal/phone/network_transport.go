package phone

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"os"
	"syscall"
	"time"

	"github.com/danielpaulus/go-ios/ios"
	"github.com/danielpaulus/go-ios/ios/tunnel"
	"github.com/google/uuid"
	"github.com/steerlabs/opensteer/iphone-bridge/internal/wire"
)

type wirelessState struct {
	Enabled  bool
	Previous bool
	Changed  bool
	Pair     *tunnel.RemotePairRecord
}
type wirelessSettings interface {
	WifiSetting(context.Context, ios.DeviceEntry) (bool, error)
	SetWifiSetting(context.Context, ios.DeviceEntry, bool) error
}

const wirelessDomain = "com.apple.mobile.wireless_lockdown"

func wirelessLockdown(ctx context.Context, d ios.DeviceEntry) (*ios.LockDownConnection, error) {
	d.Context = ctx
	c, err := ios.ConnectLockdownWithSession(d)
	if err != nil {
		return nil, networkFailure(err)
	}
	id, err := c.GetValue("UniqueDeviceID")
	if err != nil || id != d.Properties.SerialNumber {
		c.Close()
		return nil, wire.Fail(wire.WifiIdentityMismatch)
	}
	return c, nil
}
func (SystemUSB) WifiSetting(ctx context.Context, d ios.DeviceEntry) (bool, error) {
	c, err := wirelessLockdown(ctx, d)
	if err != nil {
		return false, err
	}
	defer c.Close()
	value, err := c.GetValueForDomain("EnableWifiDebugging", wirelessDomain)
	if err != nil {
		return false, networkFailure(err)
	}
	enabled, ok := value.(bool)
	if !ok {
		return false, wire.Fail(wire.WifiTransportUnsupported)
	}
	return enabled, nil
}
func (SystemUSB) SetWifiSetting(ctx context.Context, d ios.DeviceEntry, enabled bool) error {
	c, err := wirelessLockdown(ctx, d)
	if err != nil {
		return err
	}
	defer c.Close()
	return networkError(c.SetValueForDomain("EnableWifiDebugging", wirelessDomain, enabled))
}
func networkError(err error) error {
	if err == nil {
		return nil
	}
	return networkFailure(err)
}
func networkFailure(err error) *wire.Failure {
	if errors.Is(err, syscall.EPERM) || errors.Is(err, syscall.EACCES) {
		return wire.Fail(wire.LocalNetworkPermissionRequired)
	}
	if errors.Is(err, tunnel.ErrRemotePeerProof) || errors.Is(err, ios.ErrRSDIdentityMismatch) {
		return wire.Fail(wire.WifiIdentityMismatch)
	}
	if errors.Is(err, tunnel.ErrRemotePairingRequired) {
		return wire.Fail(wire.WifiPairingRequired)
	}
	f := Classify(err, wire.WifiTransportUnsupported)
	switch f.Code {
	case wire.IdentityMismatch:
		return wire.Fail(wire.WifiIdentityMismatch)
	case wire.TrustRequired, wire.PairingRevoked:
		return wire.Fail(wire.WifiPairingRequired)
	}
	return f
}
func (m *Manager) wifiSetup(ctx context.Context, p *localPhone, method string) (interface{}, error) {
	unlock, err := m.setupLock(p)
	if err != nil {
		return nil, err
	}
	defer unlock()
	settings, ok := m.usb.(wirelessSettings)
	if !ok {
		return nil, wire.Fail(wire.WifiTransportUnsupported)
	}
	d := m.device(p)
	m.mu.Lock()
	state := m.wifi[p.identity]
	active := p.session != nil
	m.mu.Unlock()
	if active && method != "setup.disableWifi" {
		return nil, wire.Fail(wire.PhoneInUse)
	}
	switch method {
	case "setup.enableWifi":
		if d.Properties.ConnectionType != "USB" {
			return nil, wire.Fail(wire.WifiPairingRequired)
		}
		if _, err := m.usb.Inspect(ctx, d); err != nil {
			return nil, err
		}
		previous, err := settings.WifiSetting(ctx, d)
		if err != nil {
			return nil, err
		}
		lifetime, cancel := context.WithCancel(ctx)
		session, err := m.usb.Open(lifetime, ctx, d)
		if err != nil {
			cancel()
			return nil, err
		}
		_ = session.Close()
		cancel()
		if !state.Changed {
			state.Previous = previous
			state.Changed = !previous
		}
		state.Enabled = true
		// Persist intent before changing the phone so a canceled setup can restore it later.
		m.mu.Lock()
		m.wifi[p.identity] = state
		err = m.saveWifi()
		m.mu.Unlock()
		if err != nil {
			return nil, err
		}
		if !previous {
			if err := settings.SetWifiSetting(ctx, d, true); err != nil {
				return nil, err
			}
		}
	case "setup.disableWifi":
		m.mu.Lock()
		state.Enabled = false
		m.wifi[p.identity] = state
		err = m.saveWifi()
		m.mu.Unlock()
		// Withdraw admissions even when saving the preference failed.
		m.invalidateNetwork(p)
		defer func() { _ = m.reconcile() }()
		if err != nil {
			return nil, err
		}
		if state.Changed {
			if d.DeviceID < 1 {
				return nil, wire.Fail(wire.WifiPhoneNotFound)
			}
			if err := settings.SetWifiSetting(ctx, d, state.Previous); err != nil {
				return nil, err
			}
			state.Changed = false
		}
	case "setup.pairWifi":
		if !state.Enabled {
			return nil, wire.Fail(wire.WifiNotEnabled)
		}
		if d.Properties.ConnectionType != "USB" {
			return nil, wire.Fail(wire.WifiPairingRequired)
		}
		lifetime, cancel := context.WithCancel(ctx)
		defer cancel()
		s, err := m.usb.Open(lifetime, ctx, d)
		if err != nil {
			return nil, err
		}
		defer s.Close()
		x, err := s.OpenXPC(ctx, "com.apple.internal.dt.coredevice.untrusted.tunnelservice")
		if err != nil {
			return nil, networkFailure(err)
		}
		record, err := tunnel.PairRemote(ctx, x, p.identity, uuid.New().String())
		if err != nil {
			return nil, networkFailure(err)
		}
		state.Pair = record
	}
	m.mu.Lock()
	m.wifi[p.identity] = state
	err = m.saveWifi()
	m.mu.Unlock()
	if err == nil {
		err = m.reconcile()
	}
	return wire.Empty{}, err
}
func (m *Manager) invalidateNetwork(p *localPhone) {
	m.mu.Lock()
	var s *Session
	if p.entry.Properties.ConnectionType == "Network" {
		p.epoch++
		if p.cancel != nil {
			p.cancel()
		}
		s = p.session
		p.session = nil
		p.sessionID = ""
		m.revision++
	}
	m.mu.Unlock()
	if s != nil {
		_ = s.Close()
	}
	if m.publish != nil {
		m.publish(m.roster())
	}
}
func (m *Manager) openTransport(lifetime, ctx context.Context, p *localPhone) (*Session, error) {
	d := m.device(p)
	if d.Properties.ConnectionType == "USB" {
		return m.usb.Open(lifetime, ctx, d)
	}
	m.mu.Lock()
	state := m.wifi[p.identity]
	m.mu.Unlock()
	if !state.Enabled {
		return nil, wire.Fail(wire.WifiNotEnabled)
	}
	if d.DeviceID > 0 {
		s, err := m.usb.Open(lifetime, ctx, d)
		if err == nil {
			return s, nil
		}
		reason := networkFailure(err)
		// Only a failed transport probe permits the contingency; setup/security refusals remain authoritative.
		switch reason.Code {
		case wire.WifiTransportUnsupported, wire.TunnelFailed, wire.ServiceMissing, wire.ProtocolUnsupported, wire.USBMuxUnavailable, wire.PhoneDisconnected:
		default:
			return nil, reason
		}
	}
	if !state.Pair.Valid() {
		return nil, wire.Fail(wire.WifiPairingRequired)
	}
	candidates, err := m.browse(ctx)
	if err != nil {
		return nil, networkFailure(err)
	}
	selected, err := selectRemoteCandidate(candidates, state.Pair.PeerIRK, time.Now())
	if err != nil {
		return nil, err
	}
	dial := func(ctx context.Context, port uint16) (net.Conn, error) {
		if !selected.validEndpoint(time.Now()) {
			return nil, wire.Fail(wire.WifiPhoneNotFound)
		}
		// Reconcile the local interface before each dial; a cached address cannot escape onto a VPN.
		interfaces, err := m.interfaces()
		if err != nil {
			return nil, networkFailure(err)
		}
		valid := false
		for _, i := range interfaces {
			if i.Index == selected.Interface.Index && i.Name == selected.Interface.Name {
				copy := selected
				copy.Interface = i
				valid = copy.validEndpoint(time.Now())
			}
		}
		if !valid {
			return nil, wire.Fail(wire.WifiPhoneNotFound)
		}
		return m.dial(ctx, selected, port)
	}
	control, err := dial(ctx, selected.Port)
	if err != nil {
		return nil, networkFailure(err)
	}
	t, err := tunnel.OpenRemoteUserspace(lifetime, ctx, control, state.Pair, dial)
	if err != nil {
		return nil, networkFailure(err)
	}
	s, err := sessionFromTunnel(ctx, t, p.identity)
	if err != nil {
		return nil, networkFailure(err)
	}
	return s, nil
}
func (m *Manager) loadWifi() error {
	m.wifi = map[string]wirelessState{}
	f, err := m.root.OpenFile("wifi.v1.json", os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return wire.Fail(wire.NotInitialized)
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || !privateFile(info) {
		return wire.Fail(wire.NotInitialized)
	}
	data, err := io.ReadAll(io.LimitReader(f, 131073))
	if err != nil || len(data) > 131072 || wire.StrictDecode(data, &m.wifi) != nil || len(m.wifi) > 64 {
		return wire.Fail(wire.NotInitialized)
	}
	for id, state := range m.wifi {
		if len(id) == 0 || len(id) > 128 || (state.Pair != nil && (!state.Pair.Valid() || state.Pair.UDID != id)) {
			return wire.Fail(wire.NotInitialized)
		}
	}
	return nil
}
func (m *Manager) saveWifi() error {
	data, err := json.Marshal(m.wifi)
	if err != nil || len(data) > 131072 {
		return wire.Fail(wire.NativeServiceFailed)
	}
	f, err := m.root.OpenFile("wifi.v1.tmp", os.O_WRONLY|os.O_CREATE|syscall.O_NOFOLLOW, 0600)
	if err != nil {
		return wire.Fail(wire.NativeServiceFailed)
	}
	info, e := f.Stat()
	if e != nil || !privateFile(info) {
		f.Close()
		return wire.Fail(wire.NativeServiceFailed)
	}
	err = f.Truncate(0)
	if err == nil {
		_, err = f.Write(data)
	}
	if err == nil {
		err = f.Sync()
	}
	err = errors.Join(err, f.Close())
	if err == nil {
		err = m.root.Rename("wifi.v1.tmp", "wifi.v1.json")
	}
	if err == nil {
		directory, e := m.root.Open(".")
		if e != nil {
			err = e
		} else {
			err = errors.Join(directory.Sync(), directory.Close())
		}
	}
	return ClassifyOrNil(err, wire.NativeServiceFailed)
}

func (m *Manager) preemptWifi(ref wire.PhoneRef) (wire.PhoneRef, error) {
	m.mu.Lock()
	p := m.phones[ref.LocalPhoneID]
	if p == nil || p.epoch != ref.NativeEpoch {
		m.mu.Unlock()
		return ref, wire.Fail(wire.StaleEpoch)
	}
	var session *Session
	if p.entry.Properties.ConnectionType == "Network" {
		p.epoch++
		ref.NativeEpoch = p.epoch
		if p.routeCancel != nil {
			p.routeCancel()
		}
		p.routeCtx, p.routeCancel = context.WithCancel(m.ctx)
		if p.cancel != nil {
			p.cancel()
		}
		session = p.session
		p.session = nil
		p.sessionID = ""
		m.revision++
	}
	m.mu.Unlock()
	if session != nil {
		_ = session.Close()
	}
	return ref, nil
}
func (m *Manager) restoreWifi(ref wire.PhoneRef) {
	defer m.wg.Done()
	defer func() { m.mu.Lock(); delete(m.restoring, ref.LocalPhoneID); m.mu.Unlock() }()
	ctx, cancel := context.WithTimeout(m.ctx, 5*time.Second)
	defer cancel()
	_, _ = m.withPhone(ctx, ref, func(ctx context.Context, p *localPhone) (interface{}, error) {
		return m.wifiSetup(ctx, p, "setup.disableWifi")
	})
}
