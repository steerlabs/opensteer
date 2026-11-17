package phone

import (
	"context"
	"github.com/danielpaulus/go-ios/ios"
	"github.com/steerlabs/opensteer/iphone-bridge/internal/wire"
	"io"
	"net"
	"testing"
	"time"
)

func TestDirectWifiInventoryAndLaunchValidationUseSessionServices(t *testing.T) {
	m := newTestManager(t)
	id := "direct-inventory-fixture"
	m.wifi[id] = wirelessState{Enabled: true}
	if err := m.reconcile(); err != nil {
		t.Fatal(err)
	}
	p := m.phones[m.identities[id]]
	if p.entry.DeviceID != -1 {
		t.Fatal("test acquired a usbmux device")
	}
	screen, backend, action := screenFixture(t)
	lifetime, stop := context.WithCancel(context.Background())
	defer stop()
	connections := make(chan net.Conn, 2)
	served := make(chan error, 1)
	go func() {
		for range 2 {
			var conn net.Conn
			select {
			case conn = <-connections:
			case <-lifetime.Done():
				served <- lifetime.Err()
				return
			}
			var err error
			_ = conn.SetDeadline(time.Now().Add(time.Second))
			codec := ios.NewPlistCodec()
			checkin, err := codec.Decode(conn)
			if err == nil {
				var values map[string]interface{}
				values, err = ios.ParsePlist(checkin)
				if err == nil && values["Request"] != "RSDCheckin" {
					err = io.ErrUnexpectedEOF
				}
			}
			for range 2 {
				if err == nil {
					var data []byte
					data, err = codec.Encode(map[string]interface{}{})
					if err == nil {
						_, err = conn.Write(data)
					}
				}
			}
			if err == nil {
				_, err = codec.Decode(conn)
			}
			if err == nil {
				var data []byte
				data, err = codec.Encode(map[string]interface{}{"CurrentIndex": uint64(0), "CurrentAmount": uint64(1), "Status": "Complete", "CurrentList": []interface{}{map[string]interface{}{"CFBundleIdentifier": "fixture.app", "CFBundleDisplayName": "Fixture", "ApplicationType": "User"}}})
				if err == nil {
					_, err = conn.Write(data)
				}
			}
			_ = conn.Close()
			if err != nil {
				served <- err
				return
			}
		}
		served <- nil
	}()
	s := &Session{identity: id, announced: true, services: ios.RsdHandshakeResponse{Udid: id, Services: map[string]ios.RsdServiceEntry{"com.apple.mobile.installation_proxy.shim.remote": {Port: 10001}}}, screen: screen}
	s.dialTCP = func(ctx context.Context, port uint16) (net.Conn, error) {
		if port != 10001 {
			t.Fatalf("inventory bypassed session service map: %d", port)
		}
		client, peer := net.Pipe()
		if deadline, ok := ctx.Deadline(); ok {
			_ = client.SetDeadline(deadline)
		}
		context.AfterFunc(ctx, func() { _ = client.Close() })
		connections <- peer
		return client, nil
	}
	p.session, p.binding, p.sessionID, p.access = s, "b", "s", "control"
	screen.observation.NativeEpoch = p.epoch
	ctx, cancel := context.WithTimeout(lifetime, 3*time.Second)
	defer cancel()
	result, err := m.installedApps(ctx, &wire.AppsParams{BindingToken: "b", NativeEpoch: p.epoch, Limit: 100})
	if err != nil {
		t.Fatal(err)
	}
	apps := result.(InstalledApps)
	if len(apps.Apps) != 1 || apps.Apps[0].AppID != "fixture.app" {
		t.Fatal("tunnel inventory was not returned")
	}
	action.NativeEpoch = p.epoch
	action.Actions = []wire.Action{{Kind: "launch", AppID: apps.Apps[0].AppID}}
	cancel()
	actionCtx, cancelAction := context.WithTimeout(lifetime, 3*time.Second)
	defer cancelAction()
	if _, err := m.screenOperation(actionCtx, action); err != nil {
		t.Fatal(err)
	}
	if backend.launches != 1 {
		t.Fatal("tunnel inventory did not validate the launch")
	}
	select {
	case err := <-served:
		if err != nil {
			t.Fatal(err)
		}
	case <-actionCtx.Done():
		t.Fatal("tunnel inventory service did not finish")
	}
}

func TestInventoryFilteringPaginationAndMinimalMetadata(t *testing.T) {
	a, b := net.Pipe()
	defer a.Close()
	defer b.Close()
	_ = a.SetDeadline(time.Now().Add(time.Second))
	_ = b.SetDeadline(time.Now().Add(time.Second))
	done := make(chan error, 1)
	go func() {
		codec := ios.NewPlistCodec()
		request, e := codec.Decode(b)
		if e != nil {
			done <- e
			return
		}
		fields, e := ios.ParsePlist(request)
		if e != nil {
			done <- e
			return
		}
		options := fields["ClientOptions"].(map[string]interface{})
		if _, ok := options["ReturnAttributes"]; !ok {
			done <- io.ErrUnexpectedEOF
			return
		}
		app := func(id, label, kind string) map[string]interface{} {
			return map[string]interface{}{"CFBundleIdentifier": id, "CFBundleDisplayName": label, "ApplicationType": kind, "UIDeviceFamily": []interface{}{uint64(1)}}
		}
		hidden := app("hidden", "Hidden", "Hidden")
		background := app("background", "Background", "System")
		background["LSBackgroundOnly"] = true
		ipad := app("ipad", "iPad", "User")
		ipad["UIDeviceFamily"] = []interface{}{uint64(2)}
		list := []interface{}{app("z.app", "Beta", "User"), app("a.app", "Alpha", "System"), hidden, background, ipad}
		for _, chunk := range []map[string]interface{}{{"CurrentIndex": uint64(0), "CurrentAmount": uint64(len(list)), "CurrentList": list, "Status": "BrowsingApplications"}, {"Status": "Complete"}} {
			data, e := codec.Encode(chunk)
			if e != nil {
				done <- e
				return
			}
			if _, e = b.Write(data); e != nil {
				done <- e
				return
			}
		}
		done <- nil
	}()
	apps, e := browseInstalledApps(ios.NewDeviceConnectionWithConn(a))
	if e != nil {
		t.Fatal(e)
	}
	if e := <-done; e != nil {
		t.Fatal(e)
	}
	if len(apps) != 2 || apps[0].AppID != "a.app" {
		t.Fatalf("bad inventory %+v", apps)
	}
	page := pageApps(apps, &wire.AppsParams{Limit: 1, Offset: 1})
	if page.Total != 2 || len(page.Apps) != 1 || page.Apps[0].AppID != "z.app" {
		t.Fatal("bad page")
	}
}
func TestMissingLockFieldNeverMeansUnlocked(t *testing.T) {
	c := &fixtureChannel{reply: map[string]interface{}{"CoreDevice.output": map[string]interface{}{"PasswordProtected": false, "displays": []interface{}{map[string]interface{}{"displayId": uint64(0), "active": true}}}}}
	open := func(context.Context, string) (xpcChannel, error) { return c, nil }
	state, e := readDeviceState(context.Background(), open)
	if e != nil {
		t.Fatal(e)
	}
	if state.Lock != "unknown" || state.Rotation != nil || state.safe() == nil {
		t.Fatal("missing lock/rotation was invented")
	}
	if len(c.sent) != 2 || c.sent[0]["CoreDevice.featureIdentifier"] != "com.apple.coredevice.feature.getlockstate" {
		t.Fatal("wrong lock protocol")
	}
}

func TestCoreDeviceLockStateRequiresExplicitEvidence(t *testing.T) {
	for _, test := range []struct {
		output map[string]interface{}
		want   string
	}{
		{map[string]interface{}{"passcodeRequired": true}, "locked"},
		{map[string]interface{}{"passcodeRequired": false}, "unknown"},
		{map[string]interface{}{"passcodeRequired": false, "unlockedSinceBoot": false}, "unknown"},
		{map[string]interface{}{"passcodeRequired": false, "unlockedSinceBoot": true}, "unlocked"},
	} {
		c := &fixtureChannel{reply: map[string]interface{}{"CoreDevice.output": test.output}}
		test.output["displays"] = []interface{}{map[string]interface{}{"displayId": uint64(0), "active": true}}
		state, e := readDeviceState(context.Background(), func(context.Context, string) (xpcChannel, error) { return c, nil })
		if e != nil {
			t.Fatal(e)
		}
		if state.Lock != test.want {
			t.Fatalf("state=%s want=%s", state.Lock, test.want)
		}
	}
}
