package phone

import (
	"context"
	"reflect"
	"strings"
	"time"

	"github.com/danielpaulus/go-ios/ios/xpc"
	"github.com/steerlabs/opensteer/iphone-bridge/internal/wire"
)

const pasteboardService = "com.apple.coredevice.pasteboardservice"
const plainTextUTI = "public.utf8-plain-text"
const maxPasteboardBytes = 2 << 20

type clipboardSnapshot struct {
	items     []interface{}
	change    uint64
	hasChange bool
}
type phonePasteboard interface {
	pull(context.Context) (clipboardSnapshot, error)
	set(context.Context, []interface{}, func() error) (clipboardSnapshot, error)
}
type pasteboard struct{ open channelOpener }

func (p pasteboard) request(ctx context.Context, request map[string]interface{}, guard func() error) (map[string]interface{}, error) {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	c, err := p.open(ctx, pasteboardService)
	if err != nil {
		return nil, wire.Fail(wire.UnsupportedText)
	}
	defer c.Close()
	stop := context.AfterFunc(ctx, func() { _ = c.Close() })
	defer stop()
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if err := guard(); err != nil {
		return nil, err
	}
	if err := c.Send(request, xpc.HeartbeatRequestFlag); err != nil {
		return nil, wire.Fail(wire.UnsupportedText)
	}
	result, err := c.ReceiveOnServerClientStream()
	if err != nil || result == nil || result["error"] != nil || result["CoreDevice.error"] != nil {
		return nil, wire.Fail(wire.UnsupportedText)
	}
	reply := request["command"].(string) + "_REPLY"
	if command := result["command"]; command != nil && command != reply {
		return nil, wire.Fail(wire.UnsupportedText)
	}
	return result, nil
}
func (p pasteboard) pull(ctx context.Context) (clipboardSnapshot, error) {
	reply, err := p.request(ctx, map[string]interface{}{
		"command": "PULL", "pasteboardName": "general",
		"dataPolicy": map[string]interface{}{"promiseSecondary": map[string]interface{}{}},
	}, func() error { return nil })
	if err != nil {
		return clipboardSnapshot{}, err
	}
	return decodeClipboard(reply)
}
func (p pasteboard) set(ctx context.Context, items []interface{}, guard func() error) (clipboardSnapshot, error) {
	reply, err := p.request(ctx, map[string]interface{}{
		"command": "SET", "pasteboardName": "general", "items": items, "sourceMetadata": nil,
	}, guard)
	if err != nil {
		return clipboardSnapshot{}, err
	}
	snapshot, err := decodeClipboard(reply)
	if err != nil {
		return clipboardSnapshot{}, err
	}
	return snapshot, nil
}
func decodeClipboard(reply map[string]interface{}) (clipboardSnapshot, error) {
	snapshot, ok := reply["snapshot"].(map[string]interface{})
	if !ok {
		return clipboardSnapshot{}, wire.Fail(wire.UnsupportedText)
	}
	meta, _ := snapshot["metadata"].(map[string]interface{})
	change, hasChange := unsigned(meta["changeCount"])
	result := clipboardSnapshot{change: change, hasChange: hasChange}
	items, ok := snapshot["items"].([]interface{})
	if !ok && snapshot["items"] != nil {
		return result, wire.Fail(wire.UnsupportedText)
	}
	if len(items) > 16 {
		return result, wire.Fail(wire.NativeLimit)
	}
	budget := maxPasteboardBytes
	if !axDecodedBudget(snapshot, &budget, 0) {
		return result, wire.Fail(wire.NativeLimit)
	}
	for _, fields := range []map[string]interface{}{reply, snapshot, meta} {
		if clipboardConfidential(fields) {
			return result, wire.Fail(wire.UnsupportedText)
		}
	}
	for _, raw := range items {
		item, ok := raw.(map[string]interface{})
		if !ok || clipboardConfidential(item) {
			return result, wire.Fail(wire.UnsupportedText)
		}
		types, ok := item["types"].([]interface{})
		data, _ := item["data"].(map[string]interface{})
		if !ok || len(types) == 0 || len(types) > 32 || len(types) != len(data) {
			return result, wire.Fail(wire.UnsupportedText)
		}
		clean := make(map[string]interface{}, len(data))
		for _, rawType := range types {
			uti, ok := rawType.(string)
			if !ok || uti == "" || confidentialType(uti) {
				return result, wire.Fail(wire.UnsupportedText)
			}
			value, _ := data[uti].(map[string]interface{})
			bytes, ok := value["data"].([]byte)
			if !ok || clipboardConfidential(value) || clean[uti] != nil {
				return result, wire.Fail(wire.UnsupportedText)
			}
			clean[uti] = map[string]interface{}{"data": bytes}
		}
		result.items = append(result.items, map[string]interface{}{"types": types, "data": clean})
	}
	return result, nil
}
func clipboardConfidential(fields map[string]interface{}) bool {
	for _, name := range []string{"confidential", "isConfidential", "sensitive", "localOnly"} {
		if flag, ok := fields[name]; ok && flag != false {
			return true
		}
	}
	return false
}
func confidentialType(uti string) bool {
	uti = strings.ToLower(uti)
	return strings.Contains(uti, "concealed") || strings.Contains(uti, "confidential") || strings.Contains(uti, "transient") || uti == "com.apple.is-remote-clipboard"
}
func textClipboard(text string) []interface{} {
	return []interface{}{map[string]interface{}{
		"types": []interface{}{plainTextUTI},
		"data":  map[string]interface{}{plainTextUTI: map[string]interface{}{"data": []byte(text)}},
	}}
}

// Restore only while the staged clipboard still has the same device change count and contents.
func pasteTransaction(ctx context.Context, clipboard phonePasteboard, text string, guard func() error, insert func() error) error {
	if len(text) > maxPasteboardBytes {
		return wire.Fail(wire.NativeLimit)
	}
	if err := guard(); err != nil {
		return err
	}
	// Never overwrite a confidential, unreadable, or untracked clipboard that cannot be restored.
	previous, err := clipboard.pull(ctx)
	if err != nil {
		return err
	}
	if !previous.hasChange {
		return wire.Fail(wire.UnsupportedText)
	}
	restoreItems := previous.items
	if restoreItems == nil {
		restoreItems = []interface{}{}
	}
	items := textClipboard(text)
	restore := func(expectedChange uint64) {
		cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), time.Second)
		defer cancel()
		current, pullErr := clipboard.pull(cleanup)
		if pullErr == nil && current.hasChange && current.change == expectedChange && reflect.DeepEqual(current.items, items) {
			_, _ = clipboard.set(cleanup, restoreItems, func() error { return nil })
		}
	}
	staged, err := clipboard.set(ctx, items, guard)
	if err != nil {
		restore(previous.change + 1)
		return err
	}
	if !staged.hasChange || staged.change != previous.change+1 {
		restore(previous.change + 1)
		return wire.Fail(wire.UnsupportedText)
	}
	defer restore(staged.change)
	return insert()
}
