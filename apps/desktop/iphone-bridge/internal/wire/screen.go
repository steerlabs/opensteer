package wire

import (
	"encoding/json"
	"math"
	"unicode/utf8"
)

// N2 native screen operations; network operations have a separate owner.
const (
	StaleObservation         Reason = "stale-observation"
	OutcomeUnknown           Reason = "outcome-unknown"
	DisplayUnsupported       Reason = "display-configuration-unsupported"
	GeometryUnavailable      Reason = "geometry-unavailable"
	AccessibilityUnavailable Reason = "accessibility-unavailable"
	UnsupportedText          Reason = "unsupported-text"
	UnsupportedClear         Reason = "unsupported-clear"
	LockUnknown              Reason = "lock-state-unknown"
	WakeRequired             Reason = "wake-on-phone-required"
	DisplayUnknown           Reason = "screen-state-unknown"
	AppUnavailable           Reason = "app-not-launchable"
	NativeLimit              Reason = "native-limit-exceeded"
)

var screenReasons = []Reason{StaleObservation, OutcomeUnknown, DisplayUnsupported, GeometryUnavailable, AccessibilityUnavailable, UnsupportedText, UnsupportedClear, LockUnknown, WakeRequired, DisplayUnknown, AppUnavailable, NativeLimit}

type ScreenRef struct {
	BindingToken string `json:"bindingToken"`
	SessionID    string `json:"sessionId"`
	NativeEpoch  uint64 `json:"nativeEpoch"`
}
type ObserveParams struct {
	ScreenRef
	IncludeScreenshot *bool `json:"includeScreenshot"`
}
type PerformParams struct {
	ScreenRef
	ObservationToken string   `json:"observationToken"`
	GeometryRevision uint64   `json:"geometryRevision"`
	Actions          []Action `json:"actions"`
}
type AppsParams struct {
	BindingToken string  `json:"bindingToken"`
	NativeEpoch  uint64  `json:"nativeEpoch"`
	Filter       *string `json:"filter,omitempty"`
	Limit        int     `json:"limit"`
	Offset       int     `json:"offset"`
}
type Point struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}
type Target struct {
	Point  *Point `json:"point,omitempty"`
	NodeID string `json:"nodeId,omitempty"`
}
type Action struct {
	Kind       string  `json:"kind"`
	Target     *Target `json:"target,omitempty"`
	To         *Point  `json:"to,omitempty"`
	DurationMs int     `json:"durationMs,omitempty"`
	HoldMs     int     `json:"holdMs,omitempty"`
	Text       *string `json:"text,omitempty"`
	Submit     *bool   `json:"submit,omitempty"`
	Button     string  `json:"button,omitempty"`
	AppID      string  `json:"appId,omitempty"`
}

func (a *Action) UnmarshalJSON(b []byte) error {
	type plain Action
	var v plain
	if err := StrictDecode(b, &v); err != nil {
		return err
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(b, &fields); err != nil {
		return err
	}
	allowed := map[string]bool{"kind": true}
	required := []string{}
	switch v.Kind {
	case "tap":
		allowed["target"] = true
		required = []string{"target"}
	case "longPress":
		allowed["target"] = true
		allowed["durationMs"] = true
		required = []string{"target", "durationMs"}
	case "swipe", "drag":
		for _, k := range []string{"target", "to", "durationMs"} {
			allowed[k] = true
		}
		required = []string{"target", "to", "durationMs"}
		if v.Kind == "drag" {
			allowed["holdMs"] = true
			required = append(required, "holdMs")
		}
	case "type":
		for _, k := range []string{"target", "text", "submit"} {
			allowed[k] = true
		}
		required = []string{"text"}
	case "clear":
		allowed["target"] = true
	case "navigate":
		allowed["button"] = true
		required = []string{"button"}
		if v.Button != "home" && v.Button != "lock" && v.Button != "volumeUp" && v.Button != "volumeDown" {
			return ErrProtocol
		}
	case "launch":
		allowed["appId"] = true
		required = []string{"appId"}
		if !validID(v.AppID) {
			return ErrProtocol
		}
	case "wake":
	case "wait":
		allowed["durationMs"] = true
		required = []string{"durationMs"}
	default:
		return ErrProtocol
	}
	for k, val := range fields {
		if !allowed[k] || string(val) == "null" {
			return ErrProtocol
		}
	}
	for _, k := range required {
		if _, ok := fields[k]; !ok {
			return ErrProtocol
		}
	}
	if v.Target != nil {
		if (v.Target.Point == nil) == (v.Target.NodeID == "") || (v.Target.NodeID != "" && !validID(v.Target.NodeID)) {
			return ErrProtocol
		}
		if v.Target.Point != nil && !validPoint(*v.Target.Point) {
			return ErrProtocol
		}
	}
	if v.To != nil && !validPoint(*v.To) {
		return ErrProtocol
	}
	if v.DurationMs < 0 || v.DurationMs > 10000 || v.HoldMs < 0 || v.HoldMs > 2000 {
		return ErrProtocol
	}
	if v.Kind == "longPress" || v.Kind == "swipe" || v.Kind == "drag" || v.Kind == "wait" {
		if v.DurationMs < 1 {
			return ErrProtocol
		}
	}
	if v.Text != nil && (!utf8.ValidString(*v.Text) || len(*v.Text) > 16000) {
		return ErrProtocol
	}
	*a = Action(v)
	return nil
}
func validPoint(p Point) bool {
	return !math.IsNaN(p.X) && !math.IsInf(p.X, 0) && !math.IsNaN(p.Y) && !math.IsInf(p.Y, 0) && p.X >= 0 && p.Y >= 0 && p.X <= 1440 && p.Y <= 1440
}
func screenParams(method string) interface{} {
	switch method {
	case "phone.observe":
		return &ObserveParams{}
	case "phone.perform":
		return &PerformParams{}
	case "phone.installedApps":
		return &AppsParams{}
	}
	return nil
}
func validScreenRef(p ScreenRef) bool {
	return validID(p.BindingToken) && validID(p.SessionID) && p.NativeEpoch > 0 && p.NativeEpoch <= 9007199254740991
}
func validateScreenParams(v interface{}) error {
	switch p := v.(type) {
	case *ObserveParams:
		if !validScreenRef(p.ScreenRef) || p.IncludeScreenshot == nil {
			return ErrProtocol
		}
	case *PerformParams:
		if !validScreenRef(p.ScreenRef) || !validID(p.ObservationToken) || p.GeometryRevision < 1 || p.GeometryRevision > 9007199254740991 || len(p.Actions) < 1 || len(p.Actions) > 32 {
			return ErrProtocol
		}
	case *AppsParams:
		if !validID(p.BindingToken) || p.NativeEpoch < 1 || p.NativeEpoch > 9007199254740991 || p.Limit < 1 || p.Limit > 100 || p.Offset < 0 || p.Offset > 10000 || (p.Filter != nil && len(*p.Filter) > 200) {
			return ErrProtocol
		}
	}
	return nil
}
