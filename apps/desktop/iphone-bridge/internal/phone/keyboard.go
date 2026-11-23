package phone

import (
	"context"
	"slices"
	"strings"
	"time"

	"github.com/danielpaulus/go-ios/ios/xpc"
	"github.com/steerlabs/opensteer/iphone-bridge/internal/wire"
)

// Indigo's keyboard usage page is implicit. Unicode insertion and field clearing
// require separate focus/layout/secure-field qualification before they can use it.
func keyboardPayload(usage, state uint64) map[string]interface{} {
	return map[string]interface{}{"featureIdentifier": "com.apple.coredevice.feature.remote.hid.keyboard", "messageType": "IndigoKeyboardButtonEvent", "payload": map[string]interface{}{"usageCode": usage, "state": state}}
}

type keyboard struct {
	conn xpcChannel
	held []uint64
}

func (k *keyboard) down(ctx context.Context, usage uint64, guard func() error) error {
	if usage < 4 || usage > 0xe7 {
		return wire.Fail(wire.UnsupportedText)
	}
	if err := ctx.Err(); err != nil {
		return Classify(err, wire.Cancelled)
	}
	if err := guard(); err != nil {
		return err
	}
	for _, key := range k.held {
		if key == usage {
			return wire.Fail(wire.ProtocolUnsupported)
		}
	}
	k.held = append(k.held, usage)
	if err := k.conn.Send(keyboardPayload(usage, 1), xpc.HeartbeatRequestFlag); err != nil {
		return &wire.Failure{Code: wire.OutcomeUnknown, Effect: "unknown"}
	}
	return nil
}
func (k *keyboard) release() error {
	var failed bool
	for i := len(k.held) - 1; i >= 0; i-- {
		if err := k.conn.Send(keyboardPayload(k.held[i], 2), xpc.HeartbeatRequestFlag); err != nil {
			failed = true
		}
	}
	k.held = nil
	if failed {
		return &wire.Failure{Code: wire.OutcomeUnknown, Effect: "unknown"}
	}
	return nil
}

func keyboardChord(ctx context.Context, conn xpcChannel, usages []uint64, guard func() error) (err error) {
	if len(usages) < 1 || len(usages) > 8 {
		return wire.Fail(wire.UnsupportedText)
	}
	seen := map[uint64]bool{}
	for _, usage := range usages {
		if usage < 4 || usage > 0xe7 || seen[usage] {
			return wire.Fail(wire.UnsupportedText)
		}
		seen[usage] = true
	}
	keys := keyboard{conn: conn}
	submitted := false
	defer func() {
		if releaseErr := keys.release(); releaseErr != nil {
			err = releaseErr
		} else if err != nil {
			failure := Classify(err, wire.NativeServiceFailed)
			if submitted && failure.Effect == "not-started" {
				err = &wire.Failure{Code: failure.Code, Effect: "submitted"}
			}
		}
	}()
	for _, usage := range usages {
		if err = keys.down(ctx, usage, guard); err != nil {
			return err
		}
		submitted = true
	}
	return nil
}

type focusedField struct {
	ID       uint64
	Role     string
	Secure   string
	Editable string
	Value    *string
}
type editingBackend interface {
	Focus(context.Context) (focusedField, error)
	Pasteboard() phonePasteboard
}
type keyStroke struct {
	usage uint64
	shift bool
}

var keyboardNames = map[string]uint64{
	"return": 0x28, "enter": 0x28, "escape": 0x29, "esc": 0x29, "backspace": 0x2a, "tab": 0x2b,
	"space": 0x2c, "spacebar": 0x2c, "delete": 0x4c, "forwarddelete": 0x4c,
	"arrowright": 0x4f, "right": 0x4f, "arrowleft": 0x50, "left": 0x50,
	"arrowdown": 0x51, "down": 0x51, "arrowup": 0x52, "up": 0x52,
	"home": 0x4a, "end": 0x4d, "pageup": 0x4b, "pagedown": 0x4e,
	"control": 0xe0, "shift": 0xe1, "option": 0xe2, "alt": 0xe2, "command": 0xe3, "meta": 0xe3,
}
var nativeModifiers = map[string]uint64{"control": 0xe0, "shift": 0xe1, "option": 0xe2, "command": 0xe3}
var ownerModifiers = map[string]uint64{"control": 0xe0, "shift": 0xe1, "alt": 0xe2, "primary": 0xe3, "meta": 0xe3}

func asciiKey(b byte) keyStroke {
	switch {
	case b >= 'a' && b <= 'z':
		return keyStroke{uint64(b-'a') + 4, false}
	case b >= 'A' && b <= 'Z':
		return keyStroke{uint64(b-'A') + 4, true}
	}
	const plain = "1234567890-=[]\\;'`,./"
	const shifted = "!@#$%^&*()_+{}|:\"~<>?"
	usages := [...]uint64{0x1e, 0x1f, 0x20, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x2d, 0x2e, 0x2f, 0x30, 0x31, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38}
	if i := strings.IndexByte(plain, b); i >= 0 {
		return keyStroke{usages[i], false}
	}
	if i := strings.IndexByte(shifted, b); i >= 0 {
		return keyStroke{usages[i], true}
	}
	switch b {
	case '\n', '\r':
		return keyStroke{usage: 0x28}
	case '\t':
		return keyStroke{usage: 0x2b}
	case ' ':
		return keyStroke{usage: 0x2c}
	case '\b':
		return keyStroke{usage: 0x2a}
	case 0x1b:
		return keyStroke{usage: 0x29}
	case 0x7f:
		return keyStroke{usage: 0x4c}
	}
	return keyStroke{}
}
func appendKey(keys []uint64, usage uint64) []uint64 {
	if !slices.Contains(keys, usage) {
		return append(keys, usage)
	}
	return keys
}
func keyChord(name string, modifiers []string) ([]uint64, bool) {
	var key keyStroke
	if len(name) == 1 {
		key = asciiKey(name[0])
	} else {
		key.usage = keyboardNames[strings.ToLower(name)]
	}
	if key.usage == 0 {
		return nil, false
	}
	var keys []uint64
	for _, modifier := range modifiers {
		usage := nativeModifiers[modifier]
		if usage == 0 {
			return nil, false
		}
		keys = appendKey(keys, usage)
	}
	if key.shift {
		keys = appendKey(keys, 0xe1)
	}
	return appendKey(keys, key.usage), true
}
func (s *screenSession) pressKey(ctx context.Context, name string, modifiers []string, guard func() error) error {
	keys, ok := keyChord(name, modifiers)
	if !ok {
		return wire.Fail(wire.UnsupportedText)
	}
	return s.withInput(ctx, func(c xpcChannel) error { return keyboardChord(ctx, c, keys, guard) })
}

var errSensitive = wire.Fail(wire.UnsupportedText)
var errNoField = wire.Fail(wire.AccessibilityUnavailable)

func (s *screenSession) readFocus(ctx context.Context) (focusedField, error) {
	backend, ok := s.backend.(editingBackend)
	if !ok {
		return focusedField{}, wire.Fail(wire.AccessibilityUnavailable)
	}
	focus, err := backend.Focus(ctx)
	if err != nil {
		if ctx.Err() != nil {
			return focusedField{}, ctx.Err()
		}
		return focusedField{}, err
	}
	if focus.Secure == "yes" {
		return focusedField{}, errSensitive
	}
	if focus.Secure != "no" {
		return focusedField{}, wire.Fail(wire.AccessibilityUnavailable)
	}
	if focus.Editable == "no" {
		return focusedField{}, errNoField
	}
	return focus, nil
}

// A readback belongs to the original field only while its native identity agrees.
func sameFocus(before, after focusedField) bool {
	return before.ID != 0 && before.ID == after.ID
}
func (s *screenSession) typeText(ctx context.Context, text string, submit bool, guard func() error) error {
	if err := guard(); err != nil {
		return err
	}
	before, err := s.readFocus(ctx)
	if err != nil {
		return err
	}
	ascii := len(text) <= 48
	for i := 0; i < len(text); i++ {
		ascii = ascii && text[i] >= 0x20 && text[i] <= 0x7e
	}
	if len(text) > 0 && ascii {
		sent := false
		err = s.withInput(ctx, func(c xpcChannel) error {
			for i := 0; i < len(text); i++ {
				keys, _ := keyChord(text[i:i+1], nil)
				if err := keyboardChord(ctx, c, keys, guard); err != nil {
					if sent {
						return submittedError(err)
					}
					return err
				}
				sent = true
			}
			return nil
		})
		if err != nil {
			return err
		}
		after, err := s.readFocus(ctx)
		if err != nil {
			return submittedError(err)
		}
		if after.Value != nil && !sameFocus(before, after) && before.ID != 0 {
			return submittedError(wire.Fail(wire.StaleObservation))
		}
		if after.Value != nil && !insertionObserved(before.Value, *after.Value, text) {
			// Only replace the field when the same original field can be verified.
			if !sameFocus(before, after) {
				return submittedError(wire.Fail(wire.OutcomeUnknown))
			}
			replacement := text
			if before.Value != nil && *before.Value != "" {
				var attributable bool
				replacement, attributable = repairInsertion(*before.Value, *after.Value, text)
				if !attributable {
					return submittedError(wire.Fail(wire.OutcomeUnknown))
				}
			}
			if err := s.pasteText(ctx, replacement, after, true, guard); err != nil {
				return submittedError(err)
			}
		}
	} else if len(text) > 0 {
		if err := s.pasteText(ctx, text, before, false, guard); err != nil {
			return err
		}
	}
	if submit {
		if _, err := s.readFocus(ctx); err != nil {
			if len(text) > 0 {
				return submittedError(err)
			}
			return err
		}
		err := s.pressKey(ctx, "return", nil, guard)
		if len(text) > 0 {
			return submittedError(err)
		}
		return err
	}
	return nil
}

// Verify the inserted text at a boundary where it could have replaced one selection.
func insertionObserved(before *string, after, text string) bool {
	if before == nil {
		return strings.Contains(after, text)
	}
	if *before == after {
		return false
	}
	left, right := commonEdges(*before, after)
	// A matching prefix or suffix can overlap the inserted text.
	remaining := len(after) - len(text)
	if remaining < 0 || remaining > len(*before) {
		return false
	}
	start, end := max(0, remaining-right), min(left, remaining)
	return start <= end && strings.Contains(after[start:end+len(text)], text)
}

func commonEdges(before, after string) (left, right int) {
	for left < min(len(before), len(after)) && before[left] == after[left] {
		left++
	}
	for right < min(len(before), len(after)) && before[len(before)-right-1] == after[len(after)-right-1] {
		right++
	}
	return left, right
}

// Locate a single changed span without destroying untouched text in the field.
func repairInsertion(before, after, text string) (string, bool) {
	left, right := 0, 0
	old, newValue := []rune(before), []rune(after)
	for left < min(len(old), len(newValue)) && old[left] == newValue[left] {
		left++
	}
	for right < min(len(old), len(newValue))-left && old[len(old)-right-1] == newValue[len(newValue)-right-1] {
		right++
	}
	if len(newValue) == left+right {
		return "", false
	}
	return string(old[:left]) + text + string(old[len(old)-right:]), true
}
func (s *screenSession) pasteText(ctx context.Context, text string, before focusedField, replace bool, guard func() error) error {
	backend, ok := s.backend.(editingBackend)
	if !ok || backend.Pasteboard() == nil {
		return wire.Fail(wire.UnsupportedText)
	}
	return pasteTransaction(ctx, backend.Pasteboard(), text, guard, func() error {
		focus, err := s.readFocus(ctx)
		if err != nil {
			return err
		}
		if before.ID != 0 && !sameFocus(before, focus) {
			return wire.Fail(wire.StaleObservation)
		}
		if replace {
			if err := s.pressKey(ctx, "a", []string{"command"}, guard); err != nil {
				return err
			}
		}
		if err := s.pressKey(ctx, "v", []string{"command"}, guard); err != nil {
			if replace {
				return submittedError(err)
			}
			return err
		}
		// Indigo writes return before the application consumes the paste.
		if err := waitDuration(ctx, 150*time.Millisecond); err != nil {
			return submittedError(err)
		}
		after, err := s.readFocus(ctx)
		if err != nil {
			return submittedError(err)
		}
		if after.Value != nil && ((!sameFocus(before, after) && before.ID != 0) ||
			(replace && *after.Value != text) ||
			(!replace && !insertionObserved(before.Value, *after.Value, text))) {
			return &wire.Failure{Code: wire.OutcomeUnknown, Effect: "submitted"}
		}
		return nil
	})
}
func (s *screenSession) clearField(ctx context.Context, guard func() error) error {
	before, err := s.readFocus(ctx)
	if err != nil {
		return err
	}
	if err := s.pressKey(ctx, "a", []string{"command"}, guard); err != nil {
		return err
	}
	if err := s.pressKey(ctx, "backspace", nil, guard); err != nil {
		return submittedError(err)
	}
	after, err := s.readFocus(ctx)
	if err != nil {
		return submittedError(err)
	}
	if after.Value != nil && (*after.Value != "" || (before.ID != 0 && !sameFocus(before, after))) {
		return &wire.Failure{Code: wire.OutcomeUnknown, Effect: "submitted"}
	}
	return nil
}
