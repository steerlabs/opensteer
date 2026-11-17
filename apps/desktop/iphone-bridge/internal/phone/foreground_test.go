package phone

import (
	"context"
	"fmt"
	"net"
	"testing"
	"time"

	dtx "github.com/danielpaulus/go-ios/ios/dtx_codec"
	"github.com/danielpaulus/go-ios/ios/nskeyedarchiver"
)

func TestForegroundRequiresExplicitUnambiguousProcessAndExactAppPath(t *testing.T) {
	process := map[string]interface{}{"foregroundRunning": true, "realAppName": "/private/var/containers/Example.app/Example"}
	path, err := foregroundProcess([]interface{}{map[string]interface{}{"realAppName": "/another.app/App"}, process})
	if err != nil {
		t.Fatal(err)
	}
	apps := []InstalledApp{{AppID: "example.app", Label: "Example", executable: "/var/containers/Example.app/Example"}}
	if f := resolveForeground(path, apps); f == nil || f.AppID != "example.app" {
		t.Fatal("foreground process was not resolved")
	}
	if resolveForeground("/elsewhere/Example.app/Example", apps) != nil {
		t.Fatal("guessed identity from app name")
	}
	for _, list := range [][]interface{}{{}, {map[string]interface{}{"isApplication": true, "realAppName": path}}, {process, process}} {
		if _, err := foregroundProcess(list); err == nil {
			t.Fatal("accepted unknown or ambiguous foreground")
		}
	}
	self := eligibleForegroundFixture(t, "com.opensteer.opensteer", "/var/Opensteer.app", "Opensteer")
	if f := resolveForeground("file:///var/Opensteer.app/Opensteer", []InstalledApp{self}); f == nil || f.AppID != "com.opensteer.opensteer" {
		t.Fatal("self-screen identity lost")
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
	executable, err := foregroundProcess(processes)
	if err != nil || resolveForeground(executable, nil) == nil {
		t.Fatal("tunnel reply did not identify home screen")
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
