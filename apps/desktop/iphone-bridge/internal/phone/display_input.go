package phone

import (
	"context"
	"errors"
	"strings"

	"github.com/danielpaulus/go-ios/ios/xpc"
	"github.com/steerlabs/opensteer/iphone-bridge/internal/wire"
)

type ownerContact struct {
	point   wire.Point
	display uint64
	edge    uint64
}
type ownerKey struct {
	code   string
	usages []uint64
}

func (s *screenSession) ownerInputHeld() bool {
	s.inputMu.Lock()
	defer s.inputMu.Unlock()
	return s.ownerContact != nil || len(s.ownerKeys) > 0
}
func (s *screenSession) resetOwnerInputLocked() error {
	contact, keys := s.ownerContact, s.ownerKeys
	s.ownerContact, s.ownerKeys = nil, nil
	if s.input == nil {
		return nil
	}
	var failed bool
	if contact != nil {
		failed = s.input.Send(digitizerPayload(2, contact.point, contact.display, contact.edge, nil), xpc.HeartbeatRequestFlag) != nil
	}
	released := map[uint64]bool{}
	for i := len(keys) - 1; i >= 0; i-- {
		for j := len(keys[i].usages) - 1; j >= 0; j-- {
			usage := keys[i].usages[j]
			if !released[usage] {
				if s.input.Send(keyboardPayload(usage, 2), xpc.HeartbeatRequestFlag) != nil {
					failed = true
				}
				released[usage] = true
			}
		}
	}
	if failed {
		return wire.Fail(wire.OutcomeUnknown)
	}
	return nil
}
func (s *screenSession) resetOwnerInput() error {
	s.inputMu.Lock()
	defer s.inputMu.Unlock()
	err := s.resetOwnerInputLocked()
	if err != nil {
		s.closeInputLocked()
	}
	return err
}

func (s *screenSession) ownerPointer(ctx context.Context, g Geometry, event wire.DisplayInputEvent, check func() error) error {
	return s.withInput(ctx, func(c xpcChannel) error {
		if err := check(); err != nil {
			return err
		}
		if (event.Phase == "down") == (s.ownerContact != nil) {
			if event.Phase == "cancel" {
				return nil
			}
			return wire.Fail(wire.StaleObservation)
		}
		point, err := g.Normalize(wire.Point{X: *event.X * float64(g.Width-1), Y: *event.Y * float64(g.Height-1)})
		if err != nil {
			return err
		}
		phase := uint64(0)
		switch event.Phase {
		case "down":
			s.ownerContact = &ownerContact{point: point, display: g.DisplayID, edge: swipeEdge("", point, g.Rotation)}
		case "move":
			phase = 1
			s.ownerContact.point = point
		case "up":
			phase = 2
			s.ownerContact.point = point
		case "cancel":
			phase = 2
		}
		contact := s.ownerContact
		if contact.display != g.DisplayID {
			return wire.Fail(wire.StaleObservation)
		}
		if err := c.Send(digitizerPayload(phase, contact.point, contact.display, contact.edge, nil), xpc.HeartbeatRequestFlag); err != nil {
			return wire.Fail(wire.OutcomeUnknown)
		}
		if phase == 2 {
			s.ownerContact = nil
		}
		return nil
	})
}
func physicalKey(code, key string) uint64 {
	for _, prefix := range []string{"Key", "Digit"} {
		if strings.HasPrefix(code, prefix) && len(code) == len(prefix)+1 {
			return asciiKey(code[len(prefix)]).usage
		}
	}
	if usage := map[string]uint64{
		"Minus": 0x2d, "Equal": 0x2e, "BracketLeft": 0x2f, "BracketRight": 0x30, "Backslash": 0x31,
		"Semicolon": 0x33, "Quote": 0x34, "Backquote": 0x35, "Comma": 0x36, "Period": 0x37, "Slash": 0x38,
		"ControlLeft": 0xe0, "ShiftLeft": 0xe1, "AltLeft": 0xe2, "MetaLeft": 0xe3,
		"ControlRight": 0xe4, "ShiftRight": 0xe5, "AltRight": 0xe6, "MetaRight": 0xe7,
	}[code]; usage != 0 {
		return usage
	}
	if usage := keyboardNames[strings.ToLower(code)]; usage != 0 {
		return usage
	}
	if len(key) == 1 {
		return asciiKey(key[0]).usage
	}
	return keyboardNames[strings.ToLower(key)]
}
func (s *screenSession) ownerKeyEvent(ctx context.Context, event wire.DisplayInputEvent, guard func() error) error {
	if event.Action == "down" {
		if _, err := s.readFocus(ctx); err != nil && !errors.Is(err, errNoField) {
			return err
		}
	}
	return s.withInput(ctx, func(c xpcChannel) error {
		if err := guard(); err != nil {
			return err
		}
		code := *event.Code
		if code == "" {
			code = *event.Key
		}
		index := -1
		for i, k := range s.ownerKeys {
			if k.code == code {
				index = i
				break
			}
		}
		count := func(usage uint64) int {
			n := 0
			for _, k := range s.ownerKeys {
				for _, key := range k.usages {
					if key == usage {
						n++
					}
				}
			}
			return n
		}
		send := func(usage, state uint64) error {
			if err := c.Send(keyboardPayload(usage, state), xpc.HeartbeatRequestFlag); err != nil {
				return wire.Fail(wire.OutcomeUnknown)
			}
			return nil
		}
		if event.Action == "up" {
			if index < 0 {
				return nil
			}
			keys := s.ownerKeys[index].usages
			for i := len(keys) - 1; i >= 0; i-- {
				if count(keys[i]) == 1 {
					if err := send(keys[i], 2); err != nil {
						return err
					}
				}
			}
			s.ownerKeys = append(s.ownerKeys[:index], s.ownerKeys[index+1:]...)
			return nil
		}
		usage := physicalKey(*event.Code, *event.Key)
		if usage == 0 {
			return wire.Fail(wire.Unsupported)
		}
		if index >= 0 {
			return nil
		} // The phone repeats a physically held key.
		if len(s.ownerKeys) >= 16 {
			return wire.Fail(wire.NativeLimit)
		}
		var keys []uint64
		for _, m := range event.Modifiers {
			mod := ownerModifiers[m]
			if usage >= 0xe4 && mod == usage-4 {
				continue
			}
			keys = appendKey(keys, mod)
		}
		keys = appendKey(keys, usage)
		s.ownerKeys = append(s.ownerKeys, ownerKey{code: code})
		for _, key := range keys {
			alreadyDown := count(key) > 0
			s.ownerKeys[len(s.ownerKeys)-1].usages = append(s.ownerKeys[len(s.ownerKeys)-1].usages, key)
			if !alreadyDown {
				if err := send(key, 1); err != nil {
					return err
				}
			}
		}
		return nil
	})
}

func (s *screenSession) ownerEvent(ctx context.Context, g Geometry, e wire.DisplayInputEvent, guard func() error, wait pause) error {
	switch e.Kind {
	case "pointer":
		return s.ownerPointer(ctx, g, e, guard)
	case "key":
		return s.ownerKeyEvent(ctx, e, guard)
	}
	if s.ownerInputHeld() {
		return wire.Fail(wire.PhoneInUse)
	}
	switch e.Kind {
	case "nav":
		return s.withInput(ctx, func(c xpcChannel) error { return navigate(ctx, c, g, e.To, guard, wait) })
	case "scroll":
		start := wire.Point{X: *e.X, Y: *e.Y}
		to := wire.Point{X: min(1, max(0, start.X-*e.DX)), Y: min(1, max(0, start.Y-*e.DY))}
		if start == to {
			return nil
		}
		return s.withInput(ctx, func(c xpcChannel) error { return displayGesture(ctx, c, g, start, to, "none", guard, wait) })
	case "text":
		if e.Insert != nil {
			return s.typeText(ctx, *e.Insert, false, guard)
		}
		if _, err := s.readFocus(ctx); err != nil {
			return err
		}
		if e.Submit != nil {
			return s.pressKey(ctx, "return", nil, guard)
		}
		return s.withInput(ctx, func(c xpcChannel) error {
			for range *e.DeleteBackward {
				if err := keyboardChord(ctx, c, []uint64{0x2a}, guard); err != nil {
					return err
				}
			}
			return nil
		})
	case "paste":
		if e.Text == nil {
			return wire.Fail(wire.Unsupported)
		}
		focus, err := s.readFocus(ctx)
		if err != nil {
			return err
		}
		return s.pasteText(ctx, *e.Text, focus, false, guard)
	case "command":
		if _, err := s.readFocus(ctx); err != nil {
			return err
		}
		key, mods := editingCommand(e.Command)
		if key == "" {
			return wire.Fail(wire.Unsupported)
		}
		return s.pressKey(ctx, key, mods, guard)
	}
	return wire.Fail(wire.Unsupported)
}
func editingCommand(command string) (string, []string) {
	var mods []string
	if base, ok := strings.CutSuffix(command, "AndModifySelection"); ok {
		command = base
		mods = append(mods, "shift")
	}
	switch command {
	case "selectAll":
		return "a", []string{"command"}
	case "undo":
		return "z", []string{"command"}
	case "redo":
		return "z", []string{"command", "shift"}
	case "moveBackward":
		return "left", mods
	case "moveForward":
		return "right", mods
	case "moveUp":
		return "up", mods
	case "moveDown":
		return "down", mods
	case "moveWordLeft":
		return "left", append(mods, "option")
	case "moveWordRight":
		return "right", append(mods, "option")
	case "moveToLeftEndOfLine", "moveToBeginningOfLine":
		return "left", append(mods, "command")
	case "moveToRightEndOfLine", "moveToEndOfLine":
		return "right", append(mods, "command")
	case "moveToBeginningOfParagraph":
		return "up", append(mods, "option")
	case "moveToEndOfParagraph":
		return "down", append(mods, "option")
	case "moveToBeginningOfDocument":
		return "up", append(mods, "command")
	case "moveToEndOfDocument":
		return "down", append(mods, "command")
	case "deleteBackward":
		return "backspace", nil
	case "deleteForward":
		return "delete", nil
	case "deleteWordBackward":
		return "backspace", []string{"option"}
	case "deleteWordForward":
		return "delete", []string{"option"}
	case "deleteToBeginningOfLine":
		return "backspace", []string{"command"}
	case "deleteToEndOfLine", "deleteToEndOfParagraph":
		return "k", []string{"control"}
	case "transpose":
		return "t", []string{"control"}
	case "yank":
		return "y", []string{"control"}
	}
	return "", nil
}

func (s *screenSession) abortOwnerBatch(ref wire.DisplayRef, stop bool) {
	s.displayMu.Lock()
	defer s.displayMu.Unlock()
	if d := s.display; d != nil && d.ref == ref {
		if stop {
			d.ending = true
			d.hide("protected", "session-ended")
			s.privacyRevision++
		}
		if s.ownerBatchCancel != nil {
			s.ownerBatchCancel()
		}
	}
}

func (s *screenSession) displayInput(ctx context.Context, d *displaySession, geometry *uint64, events []wire.DisplayInputEvent, guard func() error, wait pause) (err error) {
	ctx, cancel := context.WithCancel(ctx)
	s.displayMu.Lock()
	s.ownerBatchCancel = cancel
	inputGeometry := d.visibleAfter
	s.displayMu.Unlock()
	defer func() {
		cancel()
		s.displayMu.Lock()
		s.ownerBatchCancel = nil
		s.displayMu.Unlock()
		if err != nil {
			_ = s.resetOwnerInput()
		}
	}()
	state, err := s.backend.State(ctx)
	if err != nil {
		s.hideDisplay("protected", "target-unavailable")
		return err
	}
	f, fgKnown := s.foregroundChecked(ctx)
	s.applyPrivacy(state, f, fgKnown)
	if err := state.safe(); err != nil {
		return err
	}
	if state.Rotation == nil {
		return wire.Fail(wire.GeometryUnavailable)
	}
	s.displayMu.Lock()
	visible := s.display == d && d.hidden == ""
	fence := d.visibleAfter
	generation := d.generation
	s.displayMu.Unlock()
	if !visible {
		return wire.Fail(wire.Unsupported)
	}
	if fence != inputGeometry || (geometry != nil && generation != *geometry) {
		return wire.Fail(wire.StaleObservation)
	}
	check := func() error {
		if err := ctx.Err(); err != nil {
			return err
		}
		if err := guard(); err != nil {
			return err
		}
		s.displayMu.Lock()
		defer s.displayMu.Unlock()
		if s.display != d || d.hidden != "" || d.visibleAfter != fence || (geometry != nil && d.generation != *geometry) {
			return wire.Fail(wire.StaleObservation)
		}
		return nil
	}
	// Pointer coordinates are normalized in the viewer's visible rotation.
	g := Geometry{Width: 2, Height: 2, Rotation: state.Rotation, DisplayID: state.DisplayID}
	s.invalidateObservation()
	for _, event := range events {
		if err := check(); err != nil {
			return err
		}
		if err := s.ownerEvent(ctx, g, event, check, wait); err != nil {
			return err
		}
	}
	return nil
}
