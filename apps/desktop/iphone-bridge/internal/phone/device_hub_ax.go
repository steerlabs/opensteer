package phone

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/danielpaulus/go-ios/ios/dtx_codec"
	"github.com/danielpaulus/go-ios/ios/nskeyedarchiver"
	"github.com/google/uuid"
	"github.com/steerlabs/opensteer/iphone-bridge/internal/wire"
	"howett.net/plist"
)

const deviceHubAXService = "com.apple.accessibility.axAuditDaemon.remoteAXService"
const legacyAXShim = "com.apple.accessibility.axAuditDaemon.remoteserver.shim.remote"

type hubAX struct {
	conn   *dtx.RawConnection
	next   int
	budget int
}

func openHubAX(ctx context.Context, dial ServiceDialer) (*hubAX, error) {
	raw, err := dial.DialService(ctx, deviceHubAXService)
	if err != nil {
		return nil, err
	}
	c := dtx.NewRawConnection(raw)
	deadline, _ := ctx.Deadline()
	_ = c.SetReadDeadline(deadline)
	_ = c.SetWriteDeadline(deadline)
	if err := instrumentCall(c, 1, 0, "_notifyOfPublishedCapabilities:", map[string]interface{}{
		"com.apple.private.DTXBlockCompression": uint64(0),
		"com.apple.private.DTXConnection":       uint64(1),
	}); err != nil {
		_ = c.Close()
		return nil, wire.Fail(wire.AccessibilityUnavailable)
	}
	if err := instrumentCall(c, 2, 0, "clientNeedsAccessibility:", true); err != nil {
		_ = c.Close()
		return nil, wire.Fail(wire.AccessibilityUnavailable)
	}
	return &hubAX{conn: c, next: 3, budget: 16 << 20}, nil
}
func (a *hubAX) close() {
	defer a.conn.Close()
	_ = a.conn.SetWriteDeadline(time.Now().Add(100 * time.Millisecond))
	_ = instrumentCall(a.conn, a.next, 0, "clientNeedsAccessibility:", false)
}

// The service expects secure-coded AXP objects. Encode the NSKeyedArchiver
// graph directly so objectID, rawElementData, bridgeDelegateToken, and NSValue
// match Apple's AXPTranslatorRequest / AXPTranslationObject wire layout.
func hubRequest(kind, attribute, action int, token, params map[string]interface{}) ([]byte, error) {
	objects := []interface{}{"$null"}
	classes := map[string]plist.UID{}
	add := func(v interface{}) plist.UID {
		objects = append(objects, v)
		return plist.UID(len(objects) - 1)
	}
	cls := func(name string) plist.UID {
		if id, ok := classes[name]; ok {
			return id
		}
		id := add(map[string]interface{}{"$classname": name, "$classes": []interface{}{name, "NSObject"}})
		classes[name] = id
		return id
	}
	var encode func(interface{}) plist.UID
	encode = func(v interface{}) plist.UID {
		if v == nil {
			return plist.UID(0)
		}
		switch typed := v.(type) {
		case map[string]interface{}:
			keys := make([]interface{}, 0, len(typed))
			vals := make([]interface{}, 0, len(typed))
			for k, val := range typed {
				keys = append(keys, encode(k))
				vals = append(vals, encode(val))
			}
			return add(map[string]interface{}{"NS.keys": keys, "NS.objects": vals, "$class": cls("NSDictionary")})
		case []interface{}:
			vals := make([]interface{}, len(typed))
			for i, val := range typed {
				vals[i] = encode(val)
			}
			return add(map[string]interface{}{"NS.objects": vals, "$class": cls("NSArray")})
		default:
			return add(v)
		}
	}
	encodeHandle := func(obj map[string]interface{}) plist.UID {
		pid := obj["pid"]
		if pid == nil {
			pid = 0
		}
		isApp := obj["isApplicationElement"]
		if isApp == nil {
			isApp = false
		}
		didPop := obj["didPopuldateAppInfo"]
		if didPop == nil {
			didPop = false
		}
		objID := obj["objectID"]
		if objID == nil {
			objID = uint64(0)
		}
		return add(map[string]interface{}{
			"rawElementData":       encode(obj["rawElementData"]),
			"bridgeDelegateToken":  encode(obj["bridgeDelegateToken"]),
			"objectID":             encode(objID),
			"pid":                  pid,
			"isApplicationElement": isApp,
			"didPopuldateAppInfo":  didPop,
			"$class":               cls("AXPTranslationObject"),
		})
	}

	var paramsUID plist.UID
	if point, ok := params["point"].(string); ok {
		pointUID := add(map[string]interface{}{"NS.pointval": encode(point), "NS.special": 1, "$class": cls("NSValue")})
		displayID := params["displayId"]
		if displayID == nil {
			displayID = 0
		}
		paramsUID = add(map[string]interface{}{
			"NS.keys":    []interface{}{encode("point"), encode("displayId")},
			"NS.objects": []interface{}{pointUID, encode(displayID)},
			"$class":     cls("NSDictionary"),
		})
	} else {
		paramsUID = encode(params)
	}
	tokenUID := plist.UID(0)
	if token != nil {
		tokenUID = encodeHandle(token)
	}
	root := add(map[string]interface{}{
		"requestType":   kind,
		"clientType":    0,
		"actionType":    action,
		"attributeType": attribute,
		"translation":   tokenUID,
		"parameters":    paramsUID,
		"$class":        cls("AXPTranslatorRequest"),
	})
	archive := map[string]interface{}{
		"$version":  100000,
		"$archiver": "NSKeyedArchiver",
		"$top":      map[string]interface{}{"root": root},
		"$objects":  objects,
	}
	return plist.Marshal(archive, plist.BinaryFormat)
}
func (a *hubAX) request(ctx context.Context, kind, attribute, action int, token, params map[string]interface{}) (interface{}, error) {
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	archive, err := hubRequest(kind, attribute, action, token, params)
	if err != nil {
		return nil, wire.Fail(wire.AccessibilityUnavailable)
	}
	id := a.next
	a.next++
	if err := instrumentCall(a.conn, id, 0, "processDataFromHost:", archive); err != nil {
		return nil, wire.Fail(wire.AccessibilityUnavailable)
	}
	for range 128 {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		msg, err := a.conn.Read()
		if err != nil {
			return nil, wire.Fail(wire.AccessibilityUnavailable)
		}
		a.budget -= len(msg.RawBytes)
		if a.budget < 0 {
			return nil, wire.Fail(wire.NativeLimit)
		}
		var selector string
		if len(msg.Payload) == 1 {
			selector, _ = msg.Payload[0].(string)
		}
		if msg.ExpectsReply {
			reply := dtx.BuildAckMessage(msg)
			if selector == "hostAPIVersion" {
				version, _ := nskeyedarchiver.ArchiveBin(7)
				reply, _ = dtx.Encode(msg.Identifier, msg.ConversationIndex+1, msg.ChannelCode, false, dtx.ResponseWithReturnValueInPayload, version, dtx.NewPrimitiveDictionary())
			}
			if err := a.conn.Send(reply); err != nil {
				return nil, wire.Fail(wire.AccessibilityUnavailable)
			}
		}
		if msg.Identifier == id && msg.ConversationIndex == 1 && msg.HasError() {
			return nil, wire.Fail(wire.AccessibilityUnavailable)
		}
		if selector != "processDataFromRemoteDevice:" {
			continue
		}
		for _, arg := range msg.Auxiliary.GetArguments() {
			response := hubResponse(arg)
			requestKind, _ := unsigned(response["associatedRequestType"])
			if requestKind != uint64(kind) {
				continue
			}
			if code, ok := unsigned(response["error"]); ok && code != 0 {
				return nil, wire.Fail(wire.AccessibilityUnavailable)
			}
			return response["resultData"], nil
		}
	}
	return nil, wire.Fail(wire.AccessibilityUnavailable)
}
func hubResponse(raw interface{}) map[string]interface{} {
	for range 2 {
		b, ok := raw.([]byte)
		if !ok {
			break
		}
		decoded, err := nskeyedarchiver.Unarchive(b)
		if err != nil || len(decoded) != 1 {
			return nil
		}
		raw = decoded[0]
	}
	response, _ := raw.(map[string]interface{})
	return response
}
func (a *hubAX) appRoot(ctx context.Context, viewport AXFrame, displayID uint64) (map[string]interface{}, error) {
	if viewport.Width <= 0 || viewport.Height <= 0 {
		return nil, wire.Fail(wire.GeometryUnavailable)
	}
	id := uuid.New()
	objectID := uint64(0)
	for _, b := range id[:8] {
		objectID = objectID<<8 | uint64(b)
	}
	carrier := map[string]interface{}{"pid": 0, "objectID": objectID, "isApplicationElement": false, "didPopuldateAppInfo": false}
	probes := [][2]float64{{0.5, 0.5}, {0.5, 0.25}, {0.5, 0.85}, {0.25, 0.5}}
	var pid uint64
	var lastErr error
	for _, probe := range probes {
		point := fmt.Sprintf("{%f, %f}", viewport.X+viewport.Width*probe[0], viewport.Y+viewport.Height*probe[1])
		hit, err := a.request(ctx, 6, 0, 0, carrier, map[string]interface{}{"point": point, "displayId": int(displayID)})
		if err != nil && displayID != 0 {
			hit, err = a.request(ctx, 6, 0, 0, carrier, map[string]interface{}{"point": point, "displayId": 0})
		}
		if err != nil {
			lastErr = err
			continue
		}
		element, _ := hit.(map[string]interface{})
		if candidate, ok := unsigned(element["pid"]); ok && candidate >= 1 {
			pid = candidate
			break
		}
	}
	if pid < 1 {
		if lastErr != nil {
			return nil, lastErr
		}
		return nil, wire.Fail(wire.AccessibilityUnavailable)
	}
	root, err := a.request(ctx, 1, 0, 0, nil, map[string]interface{}{"pid": pid})
	if err != nil {
		return nil, err
	}
	token, _ := root.(map[string]interface{})
	if rootPID, _ := unsigned(token["pid"]); rootPID != pid {
		return nil, wire.Fail(wire.AccessibilityUnavailable)
	}
	return token, nil
}
func (a *hubAX) snapshot(ctx context.Context, token map[string]interface{}, depth int, attributes ...int) (map[string]interface{}, error) {
	list := make([]interface{}, len(attributes))
	for i, id := range attributes {
		list[i] = id
	}
	value, err := a.request(ctx, 2, 52, 0, token, map[string]interface{}{"parameter": map[string]interface{}{
		"attributes": list, "maxDepth": depth, "maxChildren": 128, "maxArrayCount": 128,
		"traverseFromParentsToChildren": true, "snapshotKeyHonorModalViews": false,
	}})
	if err != nil {
		return nil, err
	}
	record, ok := value.(map[string]interface{})
	if !ok {
		return nil, wire.Fail(wire.AccessibilityUnavailable)
	}
	return record, nil
}
func (a *hubAX) semanticAction(ctx context.Context, token map[string]interface{}, action int, guard func() error) (bool, error) {
	if action != 5 && action != 11 {
		return false, wire.Fail(wire.Unsupported)
	}
	if err := guard(); err != nil {
		return false, err
	}
	result, err := a.request(ctx, 7, 0, action, token, nil)
	if err != nil {
		return false, &wire.Failure{Code: wire.OutcomeUnknown, Effect: "unknown"}
	}
	ok, _ := result.(bool)
	return ok, nil
}
func snapshotAttributes(record map[string]interface{}) map[string]interface{} {
	attr, _ := record["UIAccessibilitySnapshotKeyAttributes"].(map[string]interface{})
	return attr
}
func snapshotToken(record map[string]interface{}) map[string]interface{} {
	token, _ := record["UIAccessibilitySnapshotKeyElement"].(map[string]interface{})
	return token
}
func axEditing(attr map[string]interface{}) (secure, editable string) {
	secure, editable = "unknown", "unknown"
	traits, known := unsigned(attr["2004"])
	role, _ := attr["45"].(string)
	if traits&(1<<24) != 0 || role == "AXSecureTextField" {
		secure = "yes"
	} else if known {
		secure = "no"
	}
	if known {
		editable = "no"
		if traits&((1<<18)|(1<<21)|(1<<47)|(1<<10)) != 0 && traits&(1<<51) == 0 {
			editable = "yes"
		}
	}
	return secure, editable
}
func focusFromRecord(record map[string]interface{}) focusedField {
	token, attrs := snapshotToken(record), snapshotAttributes(record)
	id, _ := unsigned(token["objectID"])
	secure, editable := axEditing(attrs)
	role := axRole(map[string]interface{}{"45": attrs["45"], "77": attrs["2004"]}, false)
	focus := focusedField{ID: id, Role: role, Secure: secure, Editable: editable}
	if secure == "no" {
		if value, ok := attrs["2006"].(string); ok && len(value) <= 120000 {
			focus.Value = &value
		}
	}
	return focus
}
func readHubFocus(ctx context.Context, dial ServiceDialer, viewport AXFrame, displayID uint64) (focusedField, error) {
	ctx, cancel := context.WithTimeout(ctx, 2500*time.Millisecond)
	defer cancel()
	a, err := openHubAX(ctx, dial)
	if err != nil {
		return focusedField{}, err
	}
	defer a.close()
	root, err := a.appRoot(ctx, viewport, displayID)
	if err != nil {
		return focusedField{}, err
	}
	snapshot, err := a.snapshot(ctx, root, 1, 3002, 2004)
	if err != nil {
		return focusedField{}, err
	}
	record, _ := snapshotAttributes(snapshot)["3002"].(map[string]interface{})
	if record == nil {
		return focusedField{}, errNoField
	}
	focus := focusFromRecord(record)
	if focus.Secure == "yes" {
		return focus, nil
	}
	token := snapshotToken(record)
	if focus.ID == 0 || token == nil {
		return focusedField{}, wire.Fail(wire.AccessibilityUnavailable)
	}
	if focus.Secure == "unknown" {
		record, err = a.snapshot(ctx, token, 1, 2004)
		if err != nil {
			return focusedField{}, err
		}
		focus = focusFromRecord(record)
	}
	if focus.Secure != "no" || focus.Editable != "yes" {
		return focus, nil
	}
	record, err = a.snapshot(ctx, token, 1, 2004, 2006)
	if err != nil {
		return focus, nil
	}
	value := focusFromRecord(record)
	if value.ID != focus.ID {
		return focusedField{}, wire.Fail(wire.StaleObservation)
	}
	return value, nil
}
func collectHubAX(ctx context.Context, dial ServiceDialer, viewport AXFrame, displayID uint64) (AXSnapshot, error) {
	ctx, cancel := context.WithTimeout(ctx, 4500*time.Millisecond)
	defer cancel()
	a, err := openHubAX(ctx, dial)
	if err != nil {
		return AXSnapshot{}, err
	}
	defer a.close()
	root, err := a.appRoot(ctx, viewport, displayID)
	if err != nil {
		return AXSnapshot{}, err
	}
	record, err := a.snapshot(ctx, root, 12, 2001, 2003, 2004, 2025, 3003)
	if err != nil {
		return AXSnapshot{}, err
	}
	return hubNodes(record), nil
}
func hubNodes(root map[string]interface{}) AXSnapshot {
	s := AXSnapshot{Nodes: []AXNode{}, Coverage: AXCoverage{CoordinateSpace: "unqualified", Status: "partial", Reason: "quiet-window"}, viewportFrames: true}
	var walk func(map[string]interface{}, *string, int)
	walk = func(record map[string]interface{}, parent *string, depth int) {
		if len(s.Nodes) >= 1500 || depth >= 64 {
			s.Coverage.Truncated = true
			return
		}
		a := snapshotAttributes(record)
		if a == nil {
			s.Coverage.MissingChildren++
			return
		}
		id := "n" + strconv.Itoa(len(s.Nodes)+1)
		secure, editable := axEditing(a)
		node := AXNode{NodeID: id, Parent: parent, Depth: depth, Role: axRole(map[string]interface{}{"77": a["2004"]}, depth == 0),
			Label: axText(a["2001"]), Editable: editable, Secure: secure, Source: "ax"}
		if secure == "yes" {
			node.Label = ""
		}
		if visible := fieldBool(a["2025"]); visible == nil || *visible {
			node.nativeFrame = parseAXFrame(a["2003"])
		}
		if node.nativeFrame == nil {
			s.Coverage.MissingFrames++
		}
		s.Nodes = append(s.Nodes, node)
		children, _ := record["UIAccessibilitySnapshotKeyChildren"].([]interface{})
		for _, item := range children {
			child, _ := item.(map[string]interface{})
			walk(child, &id, depth+1)
		}
	}
	walk(root, nil, 0)
	s.Coverage.Received, s.Coverage.Returned = len(s.Nodes), len(s.Nodes)
	if id, ok := snapshotAttributes(root)["3003"].(string); ok && len(id) > 0 && len(id) <= 128 {
		s.Foreground = &Foreground{AppID: strings.TrimSpace(id), Label: axText(snapshotAttributes(root)["2001"])}
	}
	return s
}
