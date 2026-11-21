package wire

import (
	"encoding/json"
	"regexp"
	"unicode/utf8"
)

type DisplayRef struct {
	BindingToken string `json:"bindingToken"`
	NativeEpoch  uint64 `json:"nativeEpoch"`
	StreamID     string `json:"streamId"`
}
type DisplayStartParams struct {
	DisplayRef
	MaxLongSide int `json:"maxLongSide"`
	MaxFPS      int `json:"maxFps"`
}
type DisplayDemandParams struct {
	DisplayRef
	MaxLongSide *int `json:"maxLongSide,omitempty"`
	MaxFPS      *int `json:"maxFps,omitempty"`
}
type DisplayInputParams struct {
	DisplayRef
	Geometry *uint64             `json:"geometry,omitempty"`
	Events   []DisplayInputEvent `json:"events"`
}
type DisplayPowerParams struct {
	DisplayRef
	Action string `json:"action"`
}
type DisplayStartResult struct {
	SocketPath string `json:"socketPath"`
}
type DisplayInputResult struct {
	Outcome string `json:"outcome"`
	Reason  string `json:"reason,omitempty"`
}
type DisplayStateEvent struct {
	StreamID   string `json:"streamId"`
	State      string `json:"state"`
	Reason     string `json:"reason,omitempty"`
	Generation uint64 `json:"generation"`
	Width      int    `json:"width"`
	Height     int    `json:"height"`
	Rotation   int    `json:"rotation"`
}

type DisplayClipboardItem struct {
	Type string  `json:"type"`
	Name *string `json:"name,omitempty"`
	Size int     `json:"size"`
}
type DisplayTextEdit struct {
	ContextID string `json:"contextId"`
	Text      string `json:"text"`
	Before    string `json:"before"`
	After     string `json:"after"`
}

type DisplayInputEvent struct {
	Kind           string                 `json:"kind"`
	Phase          string                 `json:"phase,omitempty"`
	X              *float64               `json:"x,omitempty"`
	Y              *float64               `json:"y,omitempty"`
	T              *float64               `json:"t,omitempty"`
	DX             *float64               `json:"dx,omitempty"`
	DY             *float64               `json:"dy,omitempty"`
	To             string                 `json:"to,omitempty"`
	Insert         *string                `json:"insert,omitempty"`
	DeleteBackward *int                   `json:"deleteBackward,omitempty"`
	Submit         *bool                  `json:"submit,omitempty"`
	Action         string                 `json:"action,omitempty"`
	Code           *string                `json:"code,omitempty"`
	Key            *string                `json:"key,omitempty"`
	Modifiers      []string               `json:"modifiers,omitempty"`
	Location       *int                   `json:"location,omitempty"`
	Repeat         *bool                  `json:"repeat,omitempty"`
	Text           *string                `json:"text,omitempty"`
	Items          []DisplayClipboardItem `json:"items,omitempty"`
	Command        string                 `json:"command,omitempty"`
	Edit           *DisplayTextEdit       `json:"edit,omitempty"`
	ContextID      string                 `json:"contextId,omitempty"`
	Button         string                 `json:"button,omitempty"`
	ClickCount     *int                   `json:"clickCount,omitempty"`
}

var streamIDPattern = regexp.MustCompile(`(?i)^dsp_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
var editingContextID = regexp.MustCompile(`(?i)^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`)
var clipboardMIME = regexp.MustCompile(`^[a-z0-9][a-z0-9!#$&^_.+-]*/[a-z0-9][a-z0-9!#$&^_.+-]*$`)

func oneOf(value string, allowed ...string) bool {
	for _, candidate := range allowed {
		if value == candidate {
			return true
		}
	}
	return false
}
func validString(s string, minLength, maxLength int) bool {
	if !utf8.ValidString(s) {
		return false
	}
	length := 0
	for _, r := range s {
		length++
		if r > 0xffff {
			length++
		}
	}
	return length >= minLength && length <= maxLength
}
func validModifiers(modifiers []string, limit int, allowed ...string) bool {
	if len(modifiers) > limit {
		return false
	}
	for _, modifier := range modifiers {
		if !oneOf(modifier, allowed...) {
			return false
		}
	}
	return true
}
func (e *DisplayInputEvent) UnmarshalJSON(data []byte) error {
	type plain DisplayInputEvent
	var value plain
	if err := StrictDecode(data, &value); err != nil {
		return err
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		return ErrProtocol
	}
	required, optional := []string{"kind"}, []string{}
	add := func(keys ...string) { required = append(required, keys...) }
	number := func(v *float64, low, high float64) bool { return v != nil && *v >= low && *v <= high }
	switch value.Kind {
	case "pointer":
		add("phase", "x", "y", "t")
		if !oneOf(value.Phase, "down", "move", "up", "cancel") || !number(value.T, 0, 9007199254740991) {
			return ErrProtocol
		}
	case "scroll":
		add("x", "y", "dx", "dy")
		if !number(value.DX, -1, 1) || !number(value.DY, -1, 1) {
			return ErrProtocol
		}
	case "nav":
		add("to")
		if !oneOf(value.To, "back", "home", "recents", "notifications") {
			return ErrProtocol
		}
	case "text":
		switch {
		case value.Insert != nil && validString(*value.Insert, 1, 1000):
			add("insert")
		case value.DeleteBackward != nil && *value.DeleteBackward >= 1 && *value.DeleteBackward <= 100:
			add("deleteBackward")
		case value.Submit != nil && *value.Submit:
			add("submit")
		default:
			return ErrProtocol
		}
	case "key":
		add("action", "code", "key", "modifiers")
		optional = []string{"location", "repeat", "text"}
		if !oneOf(value.Action, "down", "up") || value.Code == nil || !validString(*value.Code, 0, 100) ||
			value.Key == nil || !validString(*value.Key, 0, 100) || !validModifiers(value.Modifiers, 5, "alt", "control", "meta", "shift", "primary") ||
			(value.Location != nil && (*value.Location < 0 || *value.Location > 3)) ||
			(value.Text != nil && !validString(*value.Text, 1, 64)) {
			return ErrProtocol
		}
	case "paste":
		if value.Text != nil {
			add("text")
			if !validString(*value.Text, 1, 30000) {
				return ErrProtocol
			}
		} else {
			add("items")
			if len(value.Items) < 1 || len(value.Items) > 16 {
				return ErrProtocol
			}
			total := 0
			var items []json.RawMessage
			if json.Unmarshal(fields["items"], &items) != nil {
				return ErrProtocol
			}
			for i, item := range value.Items {
				if StrictDecode(items[i], &item) != nil || !validString(item.Type, 1, 255) || !clipboardMIME.MatchString(item.Type) ||
					item.Size < 0 || item.Size > (16<<20)-total || (item.Name != nil && !validString(*item.Name, 1, 255)) {
					return ErrProtocol
				}
				total += item.Size
			}
		}
	case "command":
		add("command")
		if !oneOf(value.Command, "selectAll", "undo", "redo", "moveBackward", "moveForward", "moveUp", "moveDown",
			"moveWordLeft", "moveWordRight", "moveWordLeftAndModifySelection", "moveWordRightAndModifySelection",
			"moveToLeftEndOfLine", "moveToRightEndOfLine", "moveToLeftEndOfLineAndModifySelection", "moveToRightEndOfLineAndModifySelection",
			"moveToBeginningOfLine", "moveToEndOfLine", "moveToBeginningOfLineAndModifySelection", "moveToEndOfLineAndModifySelection",
			"moveToBeginningOfParagraph", "moveToEndOfParagraph", "moveToBeginningOfParagraphAndModifySelection", "moveToEndOfParagraphAndModifySelection",
			"moveToBeginningOfDocument", "moveToEndOfDocument", "moveToBeginningOfDocumentAndModifySelection", "moveToEndOfDocumentAndModifySelection",
			"deleteBackward", "deleteForward", "deleteWordBackward", "deleteWordForward", "deleteToBeginningOfLine", "deleteToEndOfLine", "deleteToEndOfParagraph", "transpose", "yank") {
			return ErrProtocol
		}
	case "copy":
		optional = []string{"contextId"}
		if value.ContextID != "" && !editingContextID.MatchString(value.ContextID) {
			return ErrProtocol
		}
	case "cut":
		add("contextId")
		if !editingContextID.MatchString(value.ContextID) {
			return ErrProtocol
		}
	case "edit":
		add("edit")
		edit := value.Edit
		if edit == nil || !editingContextID.MatchString(edit.ContextID) ||
			!validString(edit.Text, 0, 10000) || !validString(edit.Before, 0, 10000) || !validString(edit.After, 0, 10000) ||
			edit.Text+edit.Before+edit.After == "" {
			return ErrProtocol
		}
	case "mouse":
		add("phase", "button", "modifiers", "x", "y")
		optional = []string{"clickCount"}
		if !oneOf(value.Phase, "down", "move", "up", "cancel") || !oneOf(value.Button, "none", "left", "middle", "right") ||
			!validModifiers(value.Modifiers, 5, "alt", "control", "meta", "shift", "primary") ||
			(value.ClickCount != nil && (*value.ClickCount < 1 || *value.ClickCount > 3)) {
			return ErrProtocol
		}
	default:
		return ErrProtocol
	}
	if oneOf(value.Kind, "pointer", "scroll", "mouse") && (!number(value.X, 0, 1) || !number(value.Y, 0, 1)) {
		return ErrProtocol
	}
	for _, key := range required {
		if _, ok := fields[key]; !ok {
			return ErrProtocol
		}
	}
	for key := range fields {
		if !oneOf(key, required...) && !oneOf(key, optional...) {
			return ErrProtocol
		}
	}
	*e = DisplayInputEvent(value)
	return nil
}

func displayParams(method string) interface{} {
	switch method {
	case "display.start":
		return &DisplayStartParams{}
	case "display.demand":
		return &DisplayDemandParams{}
	case "display.refresh", "display.stop", "display.inputReset":
		return &DisplayRef{}
	case "display.input":
		return &DisplayInputParams{}
	case "display.power":
		return &DisplayPowerParams{}
	}
	return nil
}
func validateDisplayParams(value interface{}) error {
	var ref DisplayRef
	validSide := func(n int) bool { return n >= 320 && n <= 1920 }
	validFPS := func(n int) bool { return n >= 1 && n <= 60 }
	switch p := value.(type) {
	case *DisplayStartParams:
		ref = p.DisplayRef
		if !validSide(p.MaxLongSide) || !validFPS(p.MaxFPS) {
			return ErrProtocol
		}
	case *DisplayDemandParams:
		ref = p.DisplayRef
		if (p.MaxLongSide != nil && !validSide(*p.MaxLongSide)) || (p.MaxFPS != nil && !validFPS(*p.MaxFPS)) {
			return ErrProtocol
		}
	case *DisplayInputParams:
		ref = p.DisplayRef
		if len(p.Events) < 1 || len(p.Events) > 64 {
			return ErrProtocol
		}
		if p.Geometry != nil && (*p.Geometry < 1 || *p.Geometry > 9007199254740991) {
			return ErrProtocol
		}
	case *DisplayPowerParams:
		ref = p.DisplayRef
		if !oneOf(p.Action, "wake", "lock") {
			return ErrProtocol
		}
	case *DisplayRef:
		ref = *p
	default:
		return nil
	}
	if !validID(ref.BindingToken) || ref.NativeEpoch < 1 || ref.NativeEpoch > 9007199254740991 || !streamIDPattern.MatchString(ref.StreamID) {
		return ErrProtocol
	}
	return nil
}
