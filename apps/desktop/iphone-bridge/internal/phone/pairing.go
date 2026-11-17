package phone

import (
	"context"
	"strconv"
	"strings"
	"unicode"

	"github.com/danielpaulus/go-ios/ios"
	"github.com/danielpaulus/go-ios/ios/amfi"
	"github.com/steerlabs/opensteer/iphone-bridge/internal/wire"
)

type Inspection struct {
	Pairing       string      `json:"pairing"`
	DeveloperMode string      `json:"developerMode"`
	Name          string      `json:"name"`
	Model         string      `json:"model"`
	OSVersion     string      `json:"osVersion"`
	Build         string      `json:"build"`
	Image         string      `json:"image"`
	Tunnel        string      `json:"tunnel"`
	Lock          string      `json:"lock"`
	Reason        wire.Reason `json:"reason"`
}

func DeveloperModeStatus(value map[string]interface{}) string {
	switch v := value["DeveloperModeStatus"].(type) {
	case bool:
		if v {
			return "enabled"
		}
		return "disabled"
	default:
		return "unknown"
	}
}
func (SystemUSB) Inspect(ctx context.Context, d ios.DeviceEntry) (Inspection, error) {
	d.Context = ctx
	result := Inspection{Pairing: "unknown", DeveloperMode: "unknown", Name: "iPhone", Image: "unknown", Tunnel: "unknown", Lock: "unknown", Reason: wire.QualificationRequired}
	lockdown, err := ios.ConnectLockdownWithSession(d)
	if err != nil {
		return result, Classify(err, wire.NativeServiceFailed)
	}
	defer lockdown.Close()
	result.Pairing = "paired"
	for _, field := range []struct {
		key    string
		target *string
	}{{"DeviceName", &result.Name}, {"ProductType", &result.Model}, {"ProductVersion", &result.OSVersion}, {"BuildVersion", &result.Build}} {
		value, err := lockdown.GetValue(field.key)
		if err != nil {
			return result, Classify(err, wire.NativeServiceFailed)
		}
		s, ok := value.(string)
		if !ok {
			return result, wire.Fail(wire.ProtocolUnsupported)
		}
		*field.target = safeLabel(s)
	}
	if !strings.HasPrefix(result.Model, "iPhone") {
		return result, wire.Fail(wire.Unsupported)
	}
	if !supportedIOS(result.OSVersion) {
		return result, wire.Fail(wire.UnsupportedIOS)
	}
	conn, err := ios.ConnectToService(d, "com.apple.mobile.mobile_image_mounter")
	if err != nil {
		return result, Classify(err, wire.NativeServiceFailed)
	}
	defer conn.Close()
	codec := ios.NewPlistCodecReadWriter(conn.Reader(), conn.Writer())
	if err := codec.Write(map[string]interface{}{"Command": "QueryDeveloperModeStatus"}); err != nil {
		return result, Classify(err, wire.NativeServiceFailed)
	}
	var status map[string]interface{}
	if err := codec.Read(&status); err != nil {
		return result, Classify(err, wire.NativeServiceFailed)
	}
	result.DeveloperMode = DeveloperModeStatus(status)
	if result.DeveloperMode == "disabled" {
		result.Reason = wire.DeveloperModeRequired
	} else if result.DeveloperMode == "unknown" {
		result.Reason = wire.DeveloperModeUnknown
	}
	return result, nil
}
func safeLabel(s string) string {
	var b strings.Builder
	for _, r := range s {
		if unicode.IsControl(r) {
			continue
		}
		if b.Len()+len(string(r)) > 160 {
			break
		}
		b.WriteRune(r)
	}
	return b.String()
}

func supportedIOS(version string) bool {
	major, err := strconv.ParseUint(strings.Split(version, ".")[0], 10, 32)
	return err == nil && major >= 27
}

func (SystemUSB) RevealDeveloperMode(ctx context.Context, d ios.DeviceEntry) error {
	d.Context = ctx
	conn, err := amfi.New(d)
	if err != nil {
		return Classify(err, wire.NativeServiceFailed)
	}
	defer conn.Close()
	return ClassifyOrNil(conn.RevealDevMode(), wire.NativeServiceFailed)
}
