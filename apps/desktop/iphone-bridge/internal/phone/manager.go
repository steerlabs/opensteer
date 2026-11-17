package phone

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"syscall"
	"time"

	"github.com/danielpaulus/go-ios/ios"
	"github.com/google/uuid"
	"github.com/steerlabs/opensteer/iphone-bridge/internal/diagnostic"
	"github.com/steerlabs/opensteer/iphone-bridge/internal/wire"
)

type localPhone struct {
	entry           ios.DeviceEntry
	identity        string
	id              string
	epoch           uint64
	lane            chan struct{}
	session         *Session
	cancel          context.CancelFunc
	binding         string
	reservation     *Reservation
	sessionID       string
	inspection      Inspection
	readinessReason wire.Reason
	routeCtx        context.Context
	routeCancel     context.CancelFunc
	apps            map[string]bool
	appsEpoch       uint64
	access          string
}
type imageOption struct {
	Handle string `json:"handle"`
	Build  string `json:"build"`
}
type Manager struct {
	mu             sync.Mutex
	ctx            context.Context
	cancel         context.CancelFunc
	workCtx        context.Context
	stopWork       context.CancelFunc
	usb            USB
	wifi           map[string]wirelessState
	restoring      map[string]bool
	browse         func(context.Context) ([]NetworkCandidate, error)
	interfaces     func() ([]LANInterface, error)
	dial           func(context.Context, NetworkCandidate, uint16) (net.Conn, error)
	root           *os.Root
	rootPath       string
	identities     map[string]string
	phones         map[string]*localPhone
	images         map[string]string
	selectedImages map[string]string
	mountImage     func(context.Context, *Session, ios.DeviceEntry, string) error
	inventory      Inventory
	revision       uint64
	discovery      bool
	discoveryReady chan struct{}
	discoveryErr   error
	publish        func(wire.Roster)
	wg             sync.WaitGroup
	operations     sync.WaitGroup
	closed         bool
}

func NewManager(parent context.Context, usb USB, publish func(wire.Roster)) *Manager {
	ctx, cancel := context.WithCancel(context.WithoutCancel(parent))
	workCtx, stopWork := context.WithCancel(ctx)
	return &Manager{ctx: ctx, cancel: cancel, workCtx: workCtx, stopWork: stopWork, usb: usb, wifi: make(map[string]wirelessState), restoring: make(map[string]bool), browse: browseRemote, interfaces: lanInterfaces, dial: dialLAN, publish: publish, phones: make(map[string]*localPhone), images: make(map[string]string), selectedImages: make(map[string]string), mountImage: MountDeveloperImage, identities: make(map[string]string)}
}
func (m *Manager) Call(ctx context.Context, r wire.Request) (interface{}, error) {
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return nil, wire.Fail(wire.NoSession)
	}
	m.operations.Add(1)
	m.mu.Unlock()
	defer m.operations.Done()
	ctx, abort := context.WithCancel(ctx)
	defer abort()
	stop := context.AfterFunc(m.workCtx, abort)
	defer stop()
	p, err := wire.Params(r)
	if err != nil {
		return nil, wire.Fail(wire.ProtocolUnsupported)
	}
	if r.Method == "init" {
		return m.init(p.(*wire.InitParams))
	}
	m.mu.Lock()
	initialized := m.root != nil && !m.closed
	m.mu.Unlock()
	if !initialized {
		return nil, wire.Fail(wire.NotInitialized)
	}
	switch r.Method {
	case "images.refresh":
		m.mu.Lock()
		defer m.mu.Unlock()
		return m.refreshImages(p.(*wire.ImagesParams).ImageRoots), nil
	case "setup.withdrawWifi":
		return wire.Empty{}, m.withdrawWifi(ctx, p.(*wire.ForgetBindingParams))
	case "phone.identity":
		return m.privateIdentity(p.(*wire.IdentityParams).CandidateID)
	case "binding.forget":
		return wire.Empty{}, m.forgetPrivateBinding(p.(*wire.ForgetBindingParams))
	case "roster.get", "roster.subscribe":
		if err := m.startDiscovery(ctx); err != nil {
			return nil, err
		}
		return m.roster(), nil
	// Same-LAN setup operations never run from runtime calls.
	case "setup.enableWifi", "setup.disableWifi", "setup.pairWifi":
		ref := *p.(*wire.PhoneRef)
		if r.Method == "setup.disableWifi" {
			var err error
			ref, err = m.preemptWifi(ref)
			if err != nil {
				return nil, err
			}
		}
		return m.withPhone(ctx, ref, func(ctx context.Context, phone *localPhone) (interface{}, error) {
			return m.wifiSetup(ctx, phone, r.Method)
		})
	case "setup.inspect":
		return m.withPhone(ctx, *p.(*wire.PhoneRef), func(ctx context.Context, phone *localPhone) (interface{}, error) {
			inspection, err := m.usb.Inspect(ctx, m.device(phone))
			if err != nil {
				inspection.Reason = Classify(err, wire.NativeServiceFailed).Code
			}
			m.mu.Lock()
			phone.inspection = inspection
			m.revision++
			m.mu.Unlock()
			if m.publish != nil {
				m.publish(m.roster())
			}

			return inspection, err
		})
	case "setup.revealDeveloperMode":
		return m.withPhone(ctx, *p.(*wire.PhoneRef), func(ctx context.Context, phone *localPhone) (interface{}, error) {
			unlock, err := m.setupLock(phone)
			if err != nil {
				return nil, err
			}
			defer unlock()
			revealer, ok := m.usb.(interface {
				RevealDeveloperMode(context.Context, ios.DeviceEntry) error
			})
			if !ok {
				return nil, wire.Fail(wire.Unsupported)
			}
			return wire.Empty{}, revealer.RevealDeveloperMode(ctx, m.device(phone))
		})
	case "setup.pair":
		return m.withPhone(ctx, *p.(*wire.PhoneRef), func(ctx context.Context, phone *localPhone) (interface{}, error) {
			unlock, err := m.setupLock(phone)
			if err != nil {
				return nil, err
			}
			defer unlock()
			return wire.Empty{}, m.usb.Pair(ctx, m.device(phone))
		})
	case "setup.prepareDeveloperServices":
		params := p.(*wire.PrepareParams)
		return m.withPhone(ctx, params.PhoneRef, func(ctx context.Context, phone *localPhone) (interface{}, error) {
			return m.prepare(ctx, phone, params.ImageHandle)
		})
	case "binding.acquire":
		params := p.(*wire.BindingParams)
		return m.withPhone(ctx, params.PhoneRef, func(ctx context.Context, phone *localPhone) (interface{}, error) { return m.acquire(phone, params) })
	case "binding.probe":
		return wire.Empty{}, m.probe(ctx, p.(*wire.TokenParams).BindingToken)
	case "binding.release":
		params := p.(*wire.TokenParams)
		return wire.Empty{}, m.release(params.BindingToken, params.Forget)
	case "session.open":
		return m.open(ctx, p.(*wire.SessionParams))
	case "session.close":
		params := p.(*wire.CloseParams)
		return wire.Empty{}, m.closeSession(params.BindingToken, params.SessionID)
	// N2 screen operations.
	case "phone.observe", "phone.perform", "phone.installedApps":
		return m.screenOperation(ctx, p)
	case "phone.forget":
		params := p.(*wire.ForgetParams)
		return wire.Empty{}, m.forget(params)

	}
	return nil, wire.Fail(wire.Unsupported)
}
func (m *Manager) init(p *wire.InitParams) (interface{}, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.root != nil || m.closed {
		return nil, wire.Fail(wire.ProtocolUnsupported)
	}
	canonical, err := filepath.EvalSymlinks(p.PrivateRoot)
	if err != nil || !filepath.IsAbs(p.PrivateRoot) || canonical != filepath.Clean(p.PrivateRoot) {
		return nil, wire.Fail(wire.NotInitialized)
	}
	info, err := os.Lstat(canonical)
	if err != nil || !info.IsDir() || info.Mode().Perm() != 0700 {
		return nil, wire.Fail(wire.NotInitialized)
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || stat.Uid != uint32(os.Getuid()) {
		return nil, wire.Fail(wire.NotInitialized)
	}
	root, err := os.OpenRoot(canonical)
	if err != nil {
		return nil, wire.Fail(wire.NotInitialized)
	}
	f, err := root.OpenFile("identities.v1.json", os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err == nil {
		data, e := io.ReadAll(io.LimitReader(f, 16385))
		fi, se := f.Stat()
		f.Close()
		if e != nil || se != nil || !privateFile(fi) || len(data) > 16384 || wire.StrictDecode(data, &m.identities) != nil || len(m.identities) > 64 {
			root.Close()
			return nil, wire.Fail(wire.NotInitialized)
		}
	} else if !os.IsNotExist(err) {
		root.Close()
		return nil, wire.Fail(wire.NotInitialized)
	}
	result := m.refreshImages(p.ImageRoots)
	m.root = root
	m.rootPath = canonical
	if err := m.loadSelectedImages(); err != nil {
		root.Close()
		m.root = nil
		return nil, err
	}
	if err := m.loadWifi(); err != nil {
		root.Close()
		m.root = nil
		return nil, err
	}
	return result, nil
}
func (m *Manager) startDiscovery(ctx context.Context) error {
	m.mu.Lock()
	if m.discovery {
		ready := m.discoveryReady
		m.mu.Unlock()
		select {
		case <-ready:
			m.mu.Lock()
			err := m.discoveryErr
			m.mu.Unlock()
			return err
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	m.discovery = true
	m.discoveryReady = make(chan struct{})
	ready := m.discoveryReady
	m.wg.Add(1)
	m.mu.Unlock()
	go func() {
		defer m.wg.Done()
		defer func() { m.mu.Lock(); m.discovery = false; m.mu.Unlock() }()
		first := true
		defer func() {
			if recover() != nil {
				m.cancel()
				m.mu.Lock()
				m.discoveryErr = wire.Fail(wire.NativeServiceFailed)
				if first {
					close(ready)
				}
				m.mu.Unlock()
			}
		}()
		for m.ctx.Err() == nil {
			listener, err := m.usb.Listen(m.ctx)
			if err == nil {
				initialCtx, cancel := context.WithTimeout(m.ctx, 5*time.Second)
				list, e := m.usb.List(initialCtx)
				cancel()
				err = e
				if err == nil {
					m.inventory.Replace(list)
					err = m.reconcile()
				}
			}
			m.mu.Lock()
			m.discoveryErr = err
			if first {
				close(ready)
				first = false
			}
			m.mu.Unlock()
			if err == nil {
				for {
					event, e := listener.Next()
					if e != nil {
						err = e
						break
					}
					m.inventory.Apply(event)
					if e := m.reconcile(); e != nil {
						err = e
						break
					}
				}
			}
			if listener != nil {
				_ = listener.Close()
			}
			m.inventory.Replace(nil)
			_ = m.reconcile()
			m.mu.Lock()
			m.discoveryErr = Classify(err, wire.USBMuxUnavailable)
			m.mu.Unlock()
			timer := time.NewTimer(time.Second)
			select {
			case <-m.ctx.Done():
				timer.Stop()
				return
			case <-timer.C:
			}
		}
		if first {
			m.mu.Lock()
			m.discoveryErr = wire.Fail(wire.Cancelled)
			close(ready)
			m.mu.Unlock()
		}
	}()
	select {
	case <-ready:
		m.mu.Lock()
		err := m.discoveryErr
		m.mu.Unlock()
		return err
	case <-ctx.Done():
		return ctx.Err()
	}
}
func (m *Manager) reconcile() error {
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return context.Canceled
	}
	enabled := map[string]bool{}
	for id, state := range m.wifi {
		enabled[id] = state.Enabled
	}
	devices := m.inventory.PreferredDevices(enabled)
	presentIdentity := map[string]bool{}
	for _, d := range devices {
		presentIdentity[d.Properties.SerialNumber] = true
	}
	// An opted-in phone remains addressable for an on-demand direct probe, without subnet scanning.
	for id, on := range enabled {
		if on && !presentIdentity[id] {
			devices = append(devices, ios.DeviceEntry{DeviceID: -1, Properties: ios.DeviceProperties{SerialNumber: id, ConnectionType: "Network"}})
		}
	}
	identityLock, err := LockIdentityStore(m.root)
	if err != nil {
		m.mu.Unlock()
		return err
	}
	defer identityLock.Close()
	if err := m.loadIdentities(); err != nil {
		m.mu.Unlock()
		return err
	}
	present := make(map[string]bool)
	stale := []*Session{}
	restore := []wire.PhoneRef{}
	for _, d := range devices {
		identity := d.Properties.SerialNumber
		diagnostic.Remember(identity)
		id := m.identities[identity]
		if id == "" {
			if len(m.identities) >= 64 {
				continue
			}
			id = uuid.New().String()
			m.identities[identity] = id
		}
		present[id] = true
		phone := m.phones[id]
		if phone == nil {
			phone = &localPhone{identity: identity, id: id, epoch: 1, lane: make(chan struct{}, 1)}
			m.phones[id] = phone
		}
		// Keep a healthy in-flight route until its session ends; new sessions prefer USB.
		if phone.sessionID != "" && (phone.entry.DeviceID == -1 || m.inventory.Has(phone.entry)) {
			d = phone.entry
		}
		changedRoute := phone.entry.DeviceID != d.DeviceID || phone.entry.Properties.ConnectionType != d.Properties.ConnectionType
		if changedRoute {
			phone.epoch++
			phone.readinessReason = ""
			phone.inspection = Inspection{}
			if phone.routeCancel != nil {
				phone.routeCancel()
			}
			phone.routeCtx, phone.routeCancel = context.WithCancel(m.ctx)
			if phone.cancel != nil {
				phone.cancel()
			}
			if phone.session != nil {
				stale = append(stale, phone.session)
			}
			phone.session = nil
			phone.sessionID = ""
		}
		phone.entry = d
		state := m.wifi[identity]
		if changedRoute && d.Properties.ConnectionType == "USB" && !state.Enabled && state.Changed && !m.restoring[id] {
			m.restoring[id] = true
			restore = append(restore, wire.PhoneRef{LocalPhoneID: id, NativeEpoch: phone.epoch})
			m.wg.Add(1)
		}
	}
	for id, p := range m.phones {
		if !present[id] && p.entry.DeviceID != 0 {
			p.epoch++
			p.readinessReason = ""
			p.entry = ios.DeviceEntry{}
			if p.routeCancel != nil {
				p.routeCancel()
			}
			if p.cancel != nil {
				p.cancel()
			}
			if p.session != nil {
				stale = append(stale, p.session)
			}
			p.session = nil
			p.sessionID = ""
		}
	}
	err = m.saveIdentities()
	m.revision++
	m.mu.Unlock()
	for _, session := range stale {
		_ = session.Close()
	}
	for _, ref := range restore {
		go m.restoreWifi(ref)
	}
	if m.publish != nil {
		m.publish(m.roster())
	}
	return err
}
func (m *Manager) saveIdentities() error {
	data, err := json.Marshal(m.identities)
	if err != nil {
		return wire.Fail(wire.NativeServiceFailed)
	}
	f, err := m.root.OpenFile("identities.v1.tmp", os.O_WRONLY|os.O_CREATE|syscall.O_NOFOLLOW, 0600)
	if err != nil {
		return wire.Fail(wire.NativeServiceFailed)
	}
	info, statErr := f.Stat()
	if statErr != nil || !privateFile(info) {
		f.Close()
		return wire.Fail(wire.NativeServiceFailed)
	}
	if err := f.Truncate(0); err != nil {
		f.Close()
		return wire.Fail(wire.NativeServiceFailed)
	}
	_, err = f.Write(data)
	if err == nil {
		err = f.Sync()
	}
	err = errors.Join(err, f.Close())
	if err == nil {
		err = m.root.Rename("identities.v1.tmp", "identities.v1.json")
	}
	if err == nil {
		directory, e := m.root.Open(".")
		if e == nil {
			err = errors.Join(directory.Sync(), directory.Close())
		} else {
			err = e
		}
	}
	return ClassifyOrNil(err, wire.NativeServiceFailed)
}
func (m *Manager) roster() wire.Roster {
	m.mu.Lock()
	defer m.mu.Unlock()
	r := wire.Roster{Revision: m.revision, Candidates: []wire.Candidate{}}
	for _, p := range m.phones {
		if p.entry.DeviceID == 0 {
			continue
		}
		name := p.inspection.Name
		if name == "" {
			name = "iPhone"
		}
		transport := "usb"
		reason := wire.NotInitialized
		if p.entry.Properties.ConnectionType == "Network" {
			transport = "wifi"
			if p.entry.DeviceID == -1 && p.session == nil {
				reason = wire.WifiPhoneNotFound
			}
		}
		caps := unavailableCapabilities(reason)
		if p.session != nil {
			caps = p.session.capabilities()
		} else if p.readinessReason != "" {
			caps = unavailableCapabilities(p.readinessReason)
		}
		r.Candidates = append(r.Candidates, wire.Candidate{Trusted: p.inspection.Pairing == "paired", LocalPhoneID: p.id, NativeEpoch: p.epoch, Name: name, Model: p.inspection.Model, OSVersion: p.inspection.OSVersion, Build: p.inspection.Build, Transport: transport, Reason: candidateReason(p, reason), Capabilities: &caps})
	}
	sort.Slice(r.Candidates, func(i, j int) bool { return r.Candidates[i].LocalPhoneID < r.Candidates[j].LocalPhoneID })
	return r
}
func (m *Manager) withPhone(ctx context.Context, ref wire.PhoneRef, call func(context.Context, *localPhone) (interface{}, error)) (interface{}, error) {
	m.mu.Lock()
	p := m.phones[ref.LocalPhoneID]
	m.mu.Unlock()
	if p == nil {
		return nil, wire.Fail(wire.CandidateGone)
	}
	select {
	case p.lane <- struct{}{}:
		defer func() { <-p.lane }()
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	m.mu.Lock()
	valid := p.entry.DeviceID != 0 && p.epoch == ref.NativeEpoch
	routeCtx := p.routeCtx
	m.mu.Unlock()
	if !valid {
		return nil, wire.Fail(wire.StaleEpoch)
	}
	ctx, abort := context.WithCancel(ctx)
	defer abort()
	stop := context.AfterFunc(routeCtx, abort)
	defer stop()
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	return call(ctx, p)
}
func (m *Manager) prepare(ctx context.Context, p *localPhone, handle string) (interface{}, error) {
	unlock, err := m.setupLock(p)
	if err != nil {
		return nil, err
	}
	defer unlock()
	inspection, err := m.usb.Inspect(ctx, m.device(p))
	if err != nil {
		return nil, err
	}
	if inspection.DeveloperMode != "enabled" {
		if inspection.DeveloperMode == "unknown" {
			return nil, wire.Fail(wire.DeveloperModeUnknown)
		}
		return nil, wire.Fail(wire.DeveloperModeRequired)
	}
	m.mu.Lock()
	path := m.images[handle]
	m.mu.Unlock()
	if path == "" {
		return nil, wire.Fail(wire.ImageMissing)
	}
	lifetime, cancel := context.WithCancel(m.ctx)
	session, err := m.openTransport(lifetime, ctx, p)
	if err != nil {
		cancel()
		return nil, err
	}
	defer func() { cancel(); _ = session.Close() }()
	if err := m.mountSelectedImage(ctx, p, session, path); err != nil {
		return nil, err
	}
	m.mu.Lock()
	imageLock, lockErr := LockIdentityStore(m.root)
	if lockErr != nil {
		m.mu.Unlock()
		return nil, lockErr
	}
	err = m.loadSelectedImages()
	if err == nil {
		m.selectedImages[p.identity] = path
		err = m.saveSelectedImages()
	}
	imageLock.Close()
	m.mu.Unlock()
	if err != nil {
		return nil, err
	}
	inspection.Image = "mounted"
	inspection.Tunnel = "ready"
	inspection.Reason = wire.QualificationRequired
	return inspection, nil
}
func (m *Manager) acquire(p *localPhone, params *wire.BindingParams) (interface{}, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if p.epoch != params.NativeEpoch || p.entry.DeviceID == 0 {
		return nil, wire.Fail(wire.StaleEpoch)
	}
	if p.binding != "" {
		return nil, wire.Fail(wire.PhoneInUse)
	}
	count := 0
	for _, phone := range m.phones {
		if phone.binding != "" {
			count++
		}
	}
	if count >= 8 {
		return nil, wire.Fail(wire.PhoneInUse)
	}
	owner := Owner{params.DeploymentID, params.HostInstanceID, params.RunnerID, params.DeviceID, params.DriverGeneration}
	reservation, err := Reserve(m.root, p.identity, owner)
	if err != nil {
		return nil, err
	}
	p.reservation = reservation
	p.binding = uuid.New().String()
	if state := m.wifi[p.identity]; !state.Enabled && state.Changed && p.entry.Properties.ConnectionType == "USB" && !m.restoring[p.id] {
		m.restoring[p.id] = true
		m.wg.Add(1)
		go m.restoreWifi(wire.PhoneRef{LocalPhoneID: p.id, NativeEpoch: p.epoch})
	}
	return struct {
		BindingToken string `json:"bindingToken"`
	}{p.binding}, nil
}
func (m *Manager) findBinding(token string) *localPhone {
	for _, p := range m.phones {
		if p.binding == token && token != "" {
			return p
		}
	}
	return nil
}
func (m *Manager) release(token string, forget bool) error {
	m.mu.Lock()
	p := m.findBinding(token)
	if p == nil {
		m.mu.Unlock()
		return nil
	}
	abort := p.cancel
	session := p.session
	reservation := p.reservation
	p.session = nil
	p.binding = ""
	p.reservation = nil
	p.sessionID = ""
	p.epoch++
	p.readinessReason = ""
	m.revision++
	m.mu.Unlock()
	if m.publish != nil {
		m.publish(m.roster())
	}
	var err error
	if session != nil {
		err = session.Close()
	}
	if abort != nil {
		abort()
	}
	if reservation != nil {
		if forget {
			err = errors.Join(err, reservation.Forget())
		}
		err = errors.Join(err, reservation.Close())
	}
	return err
}
func (m *Manager) open(ctx context.Context, params *wire.SessionParams) (interface{}, error) {
	if err := m.reconcile(); err != nil {
		return nil, err
	}
	m.mu.Lock()
	p := m.findBinding(params.BindingToken)
	if p == nil {
		m.mu.Unlock()
		return nil, wire.Fail(wire.NoSession)
	}
	ref := wire.PhoneRef{LocalPhoneID: p.id, NativeEpoch: p.epoch}
	m.mu.Unlock()
	return m.withPhone(ctx, ref, func(ctx context.Context, p *localPhone) (interface{}, error) {
		m.mu.Lock()
		if p.sessionID != "" || p.binding != params.BindingToken {
			m.mu.Unlock()
			return nil, wire.Fail(wire.PhoneInUse)
		}
		p.sessionID = params.SessionID
		p.access = params.Access
		m.mu.Unlock()
		opened := false
		defer func() {
			if !opened {
				_ = m.closeSession(params.BindingToken, params.SessionID)
			}
		}()
		session, err := m.ensureTransport(ctx, p)
		if err != nil {
			return nil, err
		}
		if err := m.ensureDeveloperServices(ctx, p, session); err != nil {
			return nil, err
		}
		_ = session.Probe(ctx)
		m.mu.Lock()
		if p.binding != params.BindingToken || p.epoch != ref.NativeEpoch || p.session != session || p.sessionID != params.SessionID || ctx.Err() != nil {
			m.mu.Unlock()
			_ = session.stopControl()
			return nil, wire.Fail(wire.StaleEpoch)
		}
		p.access = params.Access
		p.sessionID = params.SessionID
		opened = true
		m.revision++
		m.mu.Unlock()
		if m.publish != nil {
			m.publish(m.roster())
		}

		return ref, nil
	})
}
func (m *Manager) closeSession(token, sessionID string) error {
	m.mu.Lock()
	p := m.findBinding(token)
	if p == nil || p.sessionID != sessionID {
		m.mu.Unlock()
		return nil
	}
	session := p.session
	p.sessionID = ""
	p.access = ""
	m.revision++
	m.mu.Unlock()
	var err error
	if session != nil {
		err = session.stopControl()
	}
	if m.publish != nil {
		m.publish(m.roster())
	}
	return err
}
func (m *Manager) Close() error {
	m.stopWork()
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return nil
	}
	m.closed = true
	tokens := []string{}
	for _, p := range m.phones {
		if p.binding != "" {
			tokens = append(tokens, p.binding)
		}
	}
	m.mu.Unlock()
	var cleanup sync.WaitGroup
	for _, token := range tokens {
		cleanup.Go(func() { _ = m.release(token, false) })
	}
	cleanup.Wait()
	m.cancel()
	m.wg.Wait()
	m.operations.Wait()
	m.mu.Lock()
	if m.root != nil {
		_ = m.root.Close()
	}
	m.mu.Unlock()
	return nil
}

func (m *Manager) device(p *localPhone) ios.DeviceEntry {
	m.mu.Lock()
	defer m.mu.Unlock()
	return p.entry
}
func (m *Manager) setupLock(p *localPhone) (func(), error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if p.reservation != nil {
		return func() {}, nil
	}
	reservation, err := LockUnbound(m.root, p.identity)
	if err != nil {
		return nil, err
	}
	return func() { err = errors.Join(err, reservation.Close()) }, nil
}
func (m *Manager) forget(params *wire.ForgetParams) error {
	m.mu.Lock()
	p := m.findBinding(params.BindingToken)
	if p == nil || p.id != params.LocalPhoneID || p.epoch != params.NativeEpoch {
		m.mu.Unlock()
		return wire.Fail(wire.NoSession)
	}
	identity := p.identity
	m.mu.Unlock()
	if err := m.release(params.BindingToken, true); err != nil {
		return err
	}
	m.mu.Lock()
	identityLock, err := LockIdentityStore(m.root)
	if err != nil {
		m.mu.Unlock()
		return err
	}
	defer identityLock.Close()
	if err := m.loadIdentities(); err != nil {
		m.mu.Unlock()
		return err
	}
	delete(m.wifi, identity)
	if err := m.saveWifi(); err != nil {
		m.mu.Unlock()
		return err
	}
	if err := m.loadSelectedImages(); err != nil {
		m.mu.Unlock()
		return err
	}
	delete(m.selectedImages, identity)
	if err := m.saveSelectedImages(); err != nil {
		m.mu.Unlock()
		return err
	}
	delete(m.identities, identity)
	delete(m.phones, p.id)
	err = m.saveIdentities()
	m.mu.Unlock()
	return err
}

// WithSession is the fenced, serialized entry point for later screen/input operations.
func (m *Manager) WithSession(ctx context.Context, token, sessionID string, epoch uint64, control bool, call func(context.Context, *Session) (interface{}, error)) (interface{}, error) {
	m.mu.Lock()
	p := m.findBinding(token)
	if p == nil {
		m.mu.Unlock()
		return nil, wire.Fail(wire.NoSession)
	}
	ref := wire.PhoneRef{LocalPhoneID: p.id, NativeEpoch: epoch}
	m.mu.Unlock()
	return m.withPhone(ctx, ref, func(ctx context.Context, p *localPhone) (interface{}, error) {
		m.mu.Lock()
		session := p.session
		valid := p.binding == token && p.sessionID == sessionID && session != nil
		access := p.access
		m.mu.Unlock()
		if !valid {
			return nil, wire.Fail(wire.NoSession)
		}
		if control && access != "control" {
			return nil, wire.Fail(wire.Unsupported)
		}
		return call(ctx, session)
	})
}

func (m *Manager) loadIdentities() error {
	f, err := m.root.OpenFile("identities.v1.json", os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return wire.Fail(wire.NotInitialized)
	}
	defer f.Close()
	info, statErr := f.Stat()
	if statErr != nil || !privateFile(info) {
		return wire.Fail(wire.NotInitialized)
	}
	data, err := io.ReadAll(io.LimitReader(f, 16385))
	if err != nil || len(data) > 16384 {
		return wire.Fail(wire.NotInitialized)
	}
	identities := map[string]string{}
	if wire.StrictDecode(data, &identities) != nil || len(identities) > 64 {
		return wire.Fail(wire.NotInitialized)
	}
	seen := map[string]bool{}
	for physical, id := range identities {
		if physical == "" || len(physical) > 128 || id == "" || len(id) > 128 || seen[id] {
			return wire.Fail(wire.NotInitialized)
		}
		seen[id] = true
	}
	m.identities = identities
	return nil
}

// This pipe is owned by desktop main; discovery and runtime projections omit UDID.
func (m *Manager) privateIdentity(candidateID string) (interface{}, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	phone := m.phones[candidateID]
	if phone == nil || phone.entry.DeviceID == 0 {
		return nil, wire.Fail(wire.CandidateGone)
	}
	return wire.IdentityResult{UDID: phone.identity}, nil
}

// Removing local authority must also work while the selected phone is offline.
func (m *Manager) forgetPrivateBinding(p *wire.ForgetBindingParams) error {
	owner := Owner{p.DeploymentID, p.HostInstanceID, p.RunnerID, p.DeviceID, p.DriverGeneration}
	m.mu.Lock()
	for _, phone := range m.phones {
		if phone.identity == p.UDID && phone.binding != "" {
			if phone.reservation == nil || phone.reservation.owner != owner {
				m.mu.Unlock()
				return wire.Fail(wire.OwnedElsewhere)
			}
			token := phone.binding
			m.mu.Unlock()
			return m.release(token, true)
		}
	}
	defer m.mu.Unlock()
	reservation, err := Reserve(m.root, p.UDID, owner)
	if err != nil {
		return err
	}
	defer reservation.Close()
	return reservation.Forget()
}

type imagesResult struct {
	Images []imageOption `json:"images"`
}

func (m *Manager) refreshImages(roots []string) imagesResult {
	options := []imageOption{}
	images := map[string]string{}
	for _, directory := range roots {
		image, err := ValidateImage(directory)
		if err != nil {
			continue
		}
		handle := uuid.New().String()
		images[handle] = directory
		options = append(options, imageOption{handle, safeLabel(image.Build)})
		image.Close()
	}
	m.images = images
	return imagesResult{options}
}

func candidateReason(p *localPhone, transportReason wire.Reason) *wire.Reason {
	if transportReason == wire.WifiPhoneNotFound {
		return reasonPointer(transportReason)
	}
	for _, r := range []wire.Reason{p.inspection.Reason, p.readinessReason} {
		switch r {
		case wire.Unsupported, wire.UnsupportedIOS, wire.OwnedElsewhere, wire.USBMuxUnavailable, wire.CandidateGone:
			return reasonPointer(r)
		}
	}
	return nil
}
