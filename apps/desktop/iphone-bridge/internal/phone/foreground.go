package phone

import (
	"context"
	"net/url"
	"path"
	"strings"
	"time"

	dtx "github.com/danielpaulus/go-ios/ios/dtx_codec"
	"github.com/danielpaulus/go-ios/ios/nskeyedarchiver"
	"github.com/steerlabs/opensteer/iphone-bridge/internal/wire"
)

const instrumentsService = "com.apple.instruments.dtservicehub"
const opensteerAppID = "com.opensteer.opensteer"

func instrumentCall(conn *dtx.RawConnection, id, channel int, selector string, args ...interface{}) error {
	payload, err := nskeyedarchiver.ArchiveBin(selector)
	if err != nil {
		return err
	}
	aux := dtx.NewPrimitiveDictionary()
	for _, arg := range args {
		// Channel negotiation uses an unarchived integer, per DTX's global channel.
		if value, ok := arg.(uint32); ok {
			aux.AddInt32(int(value))
			continue
		}
		data, err := nskeyedarchiver.ArchiveBin(arg)
		if err != nil {
			return err
		}
		aux.AddBytes(data)
	}
	data, err := dtx.Encode(id, 0, channel, true, dtx.Methodinvocation, payload, aux)
	if err != nil {
		return err
	}
	return conn.Send(data)
}
func instrumentReply(conn *dtx.RawConnection, id, channel int) ([]interface{}, error) {
	for range 64 {
		message, err := conn.Read()
		if err != nil {
			return nil, err
		}
		if message.ExpectsReply {
			if err := conn.Send(dtx.BuildAckMessage(message)); err != nil {
				return nil, err
			}
		}
		if message.Identifier == id && message.ChannelCode == channel && message.ConversationIndex == 1 {
			if message.HasError() {
				return nil, wire.Fail(wire.ProtocolUnsupported)
			}
			return message.Payload, nil
		}
	}
	return nil, wire.Fail(wire.NativeLimit)
}
func runningProcesses(ctx context.Context, dial ServiceDialer) ([]interface{}, error) {
	raw, err := dial.DialService(ctx, instrumentsService)
	if err != nil {
		return nil, err
	}
	conn := dtx.NewRawConnection(raw)
	defer conn.Close()
	deadline, _ := ctx.Deadline()
	_ = conn.SetReadDeadline(deadline)
	_ = conn.SetWriteDeadline(deadline)
	stop := context.AfterFunc(ctx, func() { _ = conn.Close() })
	defer stop()
	if err := instrumentCall(conn, 1, 0, "_notifyOfPublishedCapabilities:", map[string]interface{}{"com.apple.private.DTXBlockCompression": uint64(0), "com.apple.private.DTXConnection": uint64(1)}); err != nil {
		return nil, err
	}
	if err := instrumentCall(conn, 2, 0, "_requestChannelWithCode:identifier:", uint32(1), "com.apple.instruments.server.services.deviceinfo"); err != nil {
		return nil, err
	}
	if _, err := instrumentReply(conn, 2, 0); err != nil {
		return nil, err
	}
	if err := instrumentCall(conn, 3, 1, "runningProcesses"); err != nil {
		return nil, err
	}
	payload, err := instrumentReply(conn, 3, 1)
	if err != nil {
		return nil, err
	}
	if len(payload) != 1 {
		return nil, wire.Fail(wire.ProtocolUnsupported)
	}
	processes, ok := payload[0].([]interface{})
	if !ok || len(processes) > 10000 {
		return nil, wire.Fail(wire.ProtocolUnsupported)
	}
	return processes, nil
}

// foregroundExecutables lists every process iOS flags as running in the
// foreground. On iOS 27 that is SpringBoard plus system UI services and any
// visible app, so the list alone never names the front app.
func foregroundExecutables(processes []interface{}) []string {
	found := []string{}
	for _, value := range processes {
		process, _ := value.(map[string]interface{})
		if foreground, _ := process["foregroundRunning"].(bool); !foreground {
			continue
		}
		if executable := processPath(stringValue(process["realAppName"])); executable != "" {
			found = append(found, executable)
		}
	}
	return found
}
func stringValue(v interface{}) string {
	s, _ := v.(string)
	if len(s) > 4096 {
		return ""
	}
	return s
}
func processPath(value string) string {
	if strings.HasPrefix(value, "file://") {
		u, err := url.Parse(value)
		if err != nil || u.Host != "" {
			return ""
		}
		value = u.Path
	}
	if !strings.HasPrefix(value, "/") {
		return ""
	}
	value = path.Clean(value)
	if strings.HasPrefix(value, "/private/") {
		value = strings.TrimPrefix(value, "/private")
	}
	return value
}
func resolveForeground(executable string, apps []InstalledApp) *Foreground {
	executable = processPath(executable)
	if executable == "" {
		return nil
	}
	var found *Foreground
	for _, app := range apps {
		if app.executable != "" && processPath(app.executable) == executable {
			if found != nil {
				return nil
			}
			found = &Foreground{AppID: app.AppID, Label: app.Label}
		}
	}
	return found
}

// readForeground names the front app only when exactly one flagged executable
// is an installed app. Anything else, including SpringBoard under an overlay,
// is unknown (nil); callers treat the result as a label, never as a gate.
func readForeground(ctx context.Context, dial ServiceDialer) (*Foreground, error) {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	processes, err := runningProcesses(ctx, dial)
	if err != nil {
		return nil, err
	}
	executables := foregroundExecutables(processes)
	if len(executables) == 0 {
		return nil, nil
	}
	apps, err := readInstalledApps(ctx, dial)
	if err != nil {
		return nil, err
	}
	return pickForeground(executables, apps), nil
}
func pickForeground(executables []string, apps []InstalledApp) *Foreground {
	var found *Foreground
	for _, executable := range executables {
		app := resolveForeground(executable, apps)
		if app == nil {
			continue
		}
		if found != nil && found.AppID != app.AppID {
			return nil
		}
		found = app
	}
	return found
}
