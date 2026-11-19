package phone

import (
	"context"
	"encoding/binary"
	"fmt"
	"net"
	"testing"
	"time"

	dtx "github.com/danielpaulus/go-ios/ios/dtx_codec"
	"github.com/danielpaulus/go-ios/ios/nskeyedarchiver"
)

func TestForegroundNamesOneLaunchableAppAmongIOS27Flags(t *testing.T) {
	flagged := func(paths ...string) []interface{} {
		list := []interface{}{map[string]interface{}{"realAppName": "/var/containers/Background.app/Background"}}
		for _, p := range paths {
			list = append(list, map[string]interface{}{"foregroundRunning": true, "realAppName": p})
		}
		return list
	}
	example := eligibleForegroundFixture(t, "example.app", "/private/var/containers/Example.app", "Example")
	other := eligibleForegroundFixture(t, "other.app", "/var/containers/Other.app", "Other")
	apps := []InstalledApp{example, other}
	// iOS 27 flags SpringBoard and system UI services alongside the visible app.
	system := []string{"/System/Library/CoreServices/SpringBoard.app/SpringBoard", "/Applications/InputUI.app/InputUI", "/Applications/DockFolderViewService.app/DockFolderViewService"}
	pick := func(processes []interface{}) *Foreground {
		return pickForeground(foregroundExecutables(processes), apps)
	}
	if f := pick(flagged(append(system, "file:///var/containers/Example.app/Example")...)); f == nil || f.AppID != "example.app" {
		t.Fatalf("visible app not named: %+v", f)
	}
	if f := pick(flagged(system...)); f != nil {
		t.Fatalf("SpringBoard alone named an app: %+v", f)
	}
	if f := pick(flagged(append(system, "/var/containers/Example.app/Example", "/var/containers/Other.app/Other")...)); f != nil {
		t.Fatalf("two flagged apps named one: %+v", f)
	}
	if f := pick(flagged("/var/containers/Unknown.app/Unknown")); f != nil {
		t.Fatalf("guessed an app that isn't installed: %+v", f)
	}
	if f := settleForeground(&Foreground{AppID: "example.app"}, nil, &Foreground{AppID: opensteerAppID}); f == nil || f.AppID != opensteerAppID {
		t.Fatal("a reading of Opensteer's own screen didn't keep it private")
	}
	if settleForeground(&Foreground{AppID: "example.app"}, &Foreground{AppID: "other.app"}) != nil {
		t.Fatal("disagreeing readings named an app")
	}
	if resolveForeground("/elsewhere/Example.app/Example", apps) != nil {
		t.Fatal("guessed identity from app name")
	}
}
func eligibleForegroundFixture(t *testing.T, id, root, executable string) InstalledApp {
	t.Helper()
	app, ok := eligibleApp(map[string]interface{}{"CFBundleIdentifier": id, "CFBundleDisplayName": "Example", "ApplicationType": "User", "Path": root, "CFBundleExecutable": executable})
	if !ok {
		t.Fatal("fixture rejected")
	}
	return app
}

type foregroundDialer struct{ fixtureDialer }

func (d foregroundDialer) Close() error { return d.conn.Close() }
func (d foregroundDialer) DialService(_ context.Context, name string) (net.Conn, error) {
	if name != "com.apple.instruments.dtservicehub" {
		return nil, fmt.Errorf("unexpected foreground service")
	}
	return d.conn, nil
}
func TestRunningProcessesUsesBoundedTunnelDTX(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	client, peer := net.Pipe()
	defer peer.Close()
	_ = peer.SetDeadline(time.Now().Add(time.Second))
	served := make(chan error, 1)
	go func() {
		conn := dtx.NewRawConnection(peer)
		// A real phone first announces its own capabilities. On iOS 27 that message
		// is about 9 KB and its auxiliary header carries a buffer capacity other than 496.
		capabilities := dtx.NewPrimitiveDictionary()
		for i := 0; i < 200; i++ {
			capabilities.AddBytes([]byte(fmt.Sprintf("com.apple.instruments.server.services.capability%03d", i)))
		}
		var data []byte
		announcement, err := nskeyedarchiver.ArchiveBin("_notifyOfPublishedCapabilities:")
		if err == nil {
			data, err = dtx.Encode(1, 0, 0, false, dtx.Methodinvocation, announcement, capabilities)
			if err == nil {
				binary.LittleEndian.PutUint32(data[48:], 9200)
			}
		}
		if err != nil {
			served <- err
			return
		}
		// net.Pipe is unbuffered and the client writes before it reads.
		announced := make(chan error, 1)
		go func() { announced <- conn.Send(data) }()
		for index := 1; index <= 3; index++ {
			request, err := conn.Read()
			if err != nil {
				served <- err
				return
			}
			expected := []string{"_notifyOfPublishedCapabilities:", "_requestChannelWithCode:identifier:", "runningProcesses"}[index-1]
			if len(request.Payload) != 1 || request.Payload[0] != expected {
				served <- fmt.Errorf("incorrect Instruments request")
				return
			}
			if index == 1 {
				continue
			}
			if index == 2 {
				if err := <-announced; err != nil {
					served <- err
					return
				}
			}
			var value interface{} = nil
			if index == 3 {
				value = []interface{}{map[string]interface{}{"foregroundRunning": true, "realAppName": "/System/Library/CoreServices/SpringBoard.app/SpringBoard"}}
			}
			payload, err := nskeyedarchiver.ArchiveBin(value)
			if err == nil {
				var data []byte
				data, err = dtx.Encode(request.Identifier, 1, request.ChannelCode, false, dtx.ResponseWithReturnValueInPayload, payload, dtx.NewPrimitiveDictionary())
				if err == nil {
					err = conn.Send(data)
				}
			}
			if err != nil {
				served <- err
				return
			}
		}
		served <- nil
	}()
	processes, err := runningProcesses(ctx, &foregroundDialer{fixtureDialer{conn: client}})
	if err != nil {
		t.Fatal(err)
	}
	if len(foregroundExecutables(processes)) != 1 {
		t.Fatal("tunnel reply lost the flagged process")
	}
	select {
	case err := <-served:
		if err != nil {
			t.Fatal(err)
		}
	case <-ctx.Done():
		t.Fatal("DTX fixture did not finish")
	}
}
