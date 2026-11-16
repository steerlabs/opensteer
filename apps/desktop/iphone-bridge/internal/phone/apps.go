package phone

import (
	"bytes"
	"context"
	"sort"
	"strings"

	"github.com/danielpaulus/go-ios/ios"
	"github.com/danielpaulus/go-ios/ios/coredevice"
	"github.com/google/uuid"
	"github.com/steerlabs/opensteer/iphone-bridge/internal/wire"
	"howett.net/plist"
)

type InstalledApp struct {
	AppID string `json:"appId"`
	Label string `json:"label"`
}
type InstalledApps struct {
	Apps   []InstalledApp `json:"apps"`
	Total  int            `json:"total"`
	Offset int            `json:"offset"`
}

func launchApp(ctx context.Context, open channelOpener, id string, guard func() error) error {
	options, err := plist.Marshal(map[string]interface{}{}, plist.BinaryFormat)
	if err != nil {
		return wire.Fail(wire.NativeServiceFailed)
	}
	input := map[string]interface{}{
		"applicationSpecifier":  map[string]interface{}{"bundleIdentifier": map[string]interface{}{"_0": id}},
		"options":               map[string]interface{}{"arguments": []interface{}{}, "environmentVariables": map[string]interface{}{}, "platformSpecificOptions": options, "standardIOUsesPseudoterminals": true, "startStopped": false, "terminateExisting": false, "user": map[string]interface{}{"active": true}, "workingDirectory": nil},
		"standardIOIdentifiers": map[string]interface{}{},
	}
	out, err := exchange(ctx, open, "com.apple.coredevice.appservice", coredevice.BuildRequest(uuid.New().String(), "com.apple.coredevice.feature.launchapplication", input), guard, true)
	if err != nil {
		return err
	}
	token, ok := out["processToken"].(map[string]interface{})
	if !ok {
		return &wire.Failure{Code: wire.OutcomeUnknown, Effect: "unknown"}
	}
	if pid, ok := unsigned(token["processIdentifier"]); !ok || pid == 0 {
		return &wire.Failure{Code: wire.OutcomeUnknown, Effect: "unknown"}
	}
	return nil
}
func readInstalledApps(ctx context.Context, transport ServiceDialer) ([]InstalledApp, error) {
	conn, err := transport.DialService(ctx, inventoryService)
	if err != nil {
		return nil, Classify(err, wire.NativeServiceFailed)
	}
	defer conn.Close()
	stop := context.AfterFunc(ctx, func() { _ = conn.Close() })
	defer stop()
	if err := ios.RsdCheckin(conn); err != nil {
		return nil, Classify(err, wire.NativeServiceFailed)
	}
	return browseInstalledApps(ios.NewDeviceConnectionWithConn(conn))
}
func browseInstalledApps(conn ios.DeviceConnectionInterface) ([]InstalledApp, error) {
	codec := ios.NewPlistCodec()
	request := map[string]interface{}{"Command": "Browse", "ClientOptions": map[string]interface{}{"ShowLaunchProhibitedApps": false, "ReturnAttributes": []interface{}{"CFBundleIdentifier", "CFBundleDisplayName", "CFBundleName", "ApplicationType", "SBAppTags", "LSBackgroundOnly", "LSUIElement", "UIDeviceFamily", "CFBundleSupportedPlatforms", "IsAppClip", "IsLaunchProhibited"}}}
	encoded, err := codec.Encode(request)
	if err != nil {
		return nil, wire.Fail(wire.NativeServiceFailed)
	}
	if err = conn.Send(encoded); err != nil {
		return nil, wire.Fail(wire.NativeServiceFailed)
	}
	found := map[string]InstalledApp{}
	entries, totalBytes := 0, 0
	for range 128 {
		data, err := codec.DecodeLimit(conn.Reader(), 1<<20)
		if err != nil {
			return nil, wire.Fail(wire.NativeServiceFailed)
		}
		totalBytes += len(data)
		if totalBytes > 8<<20 {
			return nil, wire.Fail(wire.NativeLimit)
		}
		var chunk struct {
			CurrentList   []map[string]interface{}
			CurrentAmount uint64
			CurrentIndex  uint64
			Status        string
			Error         string
		}
		if err := plist.NewDecoder(bytes.NewReader(data)).Decode(&chunk); err != nil || chunk.Error != "" {
			return nil, wire.Fail(wire.NativeServiceFailed)
		}
		if chunk.CurrentAmount != uint64(len(chunk.CurrentList)) || (len(chunk.CurrentList) > 0 && chunk.CurrentIndex != uint64(entries)) || len(chunk.CurrentList) > 10000-entries {
			return nil, wire.Fail(wire.NativeLimit)
		}
		entries += len(chunk.CurrentList)
		for _, raw := range chunk.CurrentList {
			if app, ok := eligibleApp(raw); ok {
				found[app.AppID] = app
			}
		}
		if chunk.Status == "Complete" {
			apps := make([]InstalledApp, 0, len(found))
			for _, app := range found {
				apps = append(apps, app)
			}
			sort.Slice(apps, func(i, j int) bool {
				a, b := strings.ToLower(apps[i].Label), strings.ToLower(apps[j].Label)
				if a == b {
					return apps[i].AppID < apps[j].AppID
				}
				return a < b
			})
			return apps, nil
		}
		if chunk.Status != "BrowsingApplications" {
			return nil, wire.Fail(wire.ProtocolUnsupported)
		}
	}
	return nil, wire.Fail(wire.NativeLimit)
}
func eligibleApp(raw map[string]interface{}) (InstalledApp, bool) {
	id, _ := raw["CFBundleIdentifier"].(string)
	kind, _ := raw["ApplicationType"].(string)
	if id == "" || len(id) > 128 || (kind != "User" && kind != "System") {
		return InstalledApp{}, false
	}
	for _, key := range []string{"LSBackgroundOnly", "LSUIElement", "IsAppClip", "IsLaunchProhibited"} {
		if b, _ := raw[key].(bool); b {
			return InstalledApp{}, false
		}
	}
	if tags, ok := raw["SBAppTags"].([]interface{}); ok {
		for _, tag := range tags {
			if tag == "hidden" {
				return InstalledApp{}, false
			}
		}
	}
	if family, ok := raw["UIDeviceFamily"].([]interface{}); ok {
		iphone := false
		for _, value := range family {
			n, _ := unsigned(value)
			if n == 1 {
				iphone = true
			}
		}
		if !iphone {
			return InstalledApp{}, false
		}
	}
	if platforms, ok := raw["CFBundleSupportedPlatforms"].([]interface{}); ok {
		iphone := false
		for _, value := range platforms {
			if value == "iPhoneOS" {
				iphone = true
			}
		}
		if !iphone {
			return InstalledApp{}, false
		}
	}
	label := axText(raw["CFBundleDisplayName"])
	if label == "" {
		label = axText(raw["CFBundleName"])
	}
	if label == "" {
		return InstalledApp{}, false
	}
	return InstalledApp{AppID: id, Label: label}, true
}
func pageApps(apps []InstalledApp, p *wire.AppsParams) InstalledApps {
	filter := ""
	if p.Filter != nil {
		filter = strings.ToLower(*p.Filter)
	}
	filtered := []InstalledApp{}
	for _, app := range apps {
		if filter == "" || strings.Contains(strings.ToLower(app.Label), filter) || strings.Contains(strings.ToLower(app.AppID), filter) {
			filtered = append(filtered, app)
		}
	}
	start := min(p.Offset, len(filtered))
	return InstalledApps{Apps: filtered[start:min(start+p.Limit, len(filtered))], Total: len(filtered), Offset: p.Offset}
}
