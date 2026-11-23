package phone

import (
	"context"
	"io"
	"net"
	"testing"
	"time"

	"github.com/danielpaulus/go-ios/ios"
	dtx "github.com/danielpaulus/go-ios/ios/dtx_codec"
	"github.com/danielpaulus/go-ios/ios/nskeyedarchiver"
	"github.com/steerlabs/opensteer/iphone-bridge/internal/wire"
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

func TestTerminateResolvesOnlyTheInstalledExecutable(t *testing.T) {
	const fixtureExecutable = "/var/containers/Fixture.app/Fixture"
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	client, server := net.Pipe()
	defer server.Close()
	defer client.Close()
	done := make(chan error, 1)
	go func() {
		dtxConn := dtx.NewRawConnection(server)
		for stage := 0; stage < 3; stage++ {
			m, err := dtxConn.Read()
			if err != nil {
				done <- err
				return
			}
			if stage == 0 {
				continue
			}
			if stage == 1 {
				if err := dtxConn.Send(dtx.BuildAckMessage(m)); err != nil {
					done <- err
					return
				}
				continue
			}
			data, err := nskeyedarchiver.ArchiveBin([]interface{}{
				map[string]interface{}{"realAppName": "/var/containers/Other.app/Fixture", "pid": uint64(100)},
				map[string]interface{}{"realAppName": "file:///private" + fixtureExecutable, "pid": uint64(201)},
			})
			if err != nil {
				done <- err
				return
			}
			reply, err := dtx.Encode(m.Identifier, 1, m.ChannelCode, false, dtx.ResponseWithReturnValueInPayload, data, dtx.NewPrimitiveDictionary())
			if err != nil {
				done <- err
				return
			}
			done <- dtxConn.Send(reply)
		}
	}()
	c := &fixtureChannel{reply: map[string]interface{}{"CoreDevice.output": map[string]interface{}{}}}
	dial := &fixtureDialer{conn: client}
	called := 0
	open := func(_ context.Context, service string) (xpcChannel, error) {
		if service != appService {
			t.Fatal("wrong app service")
		}
		return c, nil
	}
	err := terminateApp(ctx, open, dial, []InstalledApp{{AppID: "fixture.app", executable: fixtureExecutable}}, "fixture.app", func() error { called++; return nil })
	if err != nil {
		t.Fatal(err)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if called != 1 || len(c.sent) != 1 {
		t.Fatal("terminate replayed or skipped guard")
	}
	message := c.sent[0]
	input := message["CoreDevice.input"].(map[string]interface{})
	if message["CoreDevice.featureIdentifier"] != "com.apple.coredevice.feature.sendsignaltoprocess" ||
		input["process"].(map[string]interface{})["processIdentifier"] != int64(201) || input["signal"] != int64(15) {
		t.Fatal("wrong CoreDevice terminate request")
	}
}
