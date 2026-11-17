package phone

import (
	"encoding/json"
	"fmt"
	"reflect"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/danielpaulus/go-ios/ios/nskeyedarchiver"
	"github.com/steerlabs/opensteer/iphone-bridge/internal/wire"
)

type AXFrame struct {
	X      float64 `json:"x"`
	Y      float64 `json:"y"`
	Width  float64 `json:"width"`
	Height float64 `json:"height"`
}
type AXNode struct {
	NodeID   string   `json:"nodeId"`
	Parent   *string  `json:"parent"`
	Depth    int      `json:"depth"`
	Role     string   `json:"role"`
	Label    string   `json:"label"`
	Frame    *AXFrame `json:"frame"`
	Enabled  *bool    `json:"enabled"`
	Focused  *bool    `json:"focused"`
	Selected *bool    `json:"selected"`
	Editable string   `json:"editable"`
	Secure   string   `json:"secure"`
}
type AXCoverage struct {
	CoordinateSpace string `json:"coordinateSpace"`
	Status          string `json:"status"`
	Reason          string `json:"reason"`
	Received        int    `json:"received"`
	Returned        int    `json:"returned"`
	MissingFrames   int    `json:"missingFrames"`
	MissingChildren int    `json:"missingChildren"`
	Unreturned      int    `json:"unreturned"`
	Cycles          int    `json:"cycles"`
	Truncated       bool   `json:"truncated"`
}
type AXSnapshot struct {
	Nodes      []AXNode
	Coverage   AXCoverage
	Foreground *Foreground
}
type axRecord struct {
	attributes map[string]interface{}
	frame      *AXFrame
	activation *wire.Point
}
type axTree struct {
	nodes        map[uint64]*axRecord
	roots        map[uint64]bool
	revision     uint64
	orientation  interface{}
	decodedBytes int
}

func newAXTree() *axTree { return &axTree{nodes: map[uint64]*axRecord{}, roots: map[uint64]bool{}} }
func (t *axTree) usable() bool {
	if len(t.nodes) < 2 {
		return false
	}
	for id := range t.roots {
		if _, ok := t.nodes[id]; ok {
			return true
		}
	}
	return false
}
func (t *axTree) archive(b []byte) error {
	if len(b) > 16<<20 {
		return wire.Fail(wire.NativeLimit)
	}
	decoded, e := nskeyedarchiver.Unarchive(b)
	if e != nil || len(decoded) != 1 {
		return wire.Fail(wire.ProtocolUnsupported)
	}
	if inner, ok := decoded[0].([]byte); ok {
		decoded, e = nskeyedarchiver.Unarchive(inner)
		if e != nil || len(decoded) != 1 {
			return wire.Fail(wire.ProtocolUnsupported)
		}
	}
	remaining := (16 << 20) - t.decodedBytes
	if !axDecodedBudget(decoded[0], &remaining, 0) {
		return wire.Fail(wire.NativeLimit)
	}
	t.decodedBytes = (16 << 20) - remaining
	root, ok := decoded[0].(map[string]interface{})
	if !ok {
		return nil
	}
	return t.merge(root)
}
func (t *axTree) merge(root map[string]interface{}) error {
	kind, _ := unsigned(root["associatedRequestType"])
	if kind != 11 {
		return nil
	}
	result, _ := root["resultData"].(map[string]interface{})
	dump, _ := result["treeDump"].([]interface{})
	if len(dump) > 4096 {
		return wire.Fail(wire.NativeLimit)
	}
	for _, item := range dump {
		message, ok := item.(map[string]interface{})
		if !ok {
			continue
		}
		kind, _ := unsigned(message["associatedRequestType"])
		switch kind {
		case 4:
			data, _ := message["resultData"].(map[string]interface{})
			id, ok := unsigned(data["objectID"])
			if ok && !t.roots[id] {
				if len(t.roots) >= 64 {
					return wire.Fail(wire.NativeLimit)
				}
				t.roots[id] = true
				t.revision++
			}
		case 2:
			attr, _ := unsigned(message["attribute"])
			if attr == 129 && !reflect.DeepEqual(t.orientation, message["resultData"]) {
				t.orientation = message["resultData"]
				t.revision++
			}
		case 5:
			object, _ := message["associatedTranslationObject"].(map[string]interface{})
			id, ok := unsigned(object["objectID"])
			if !ok {
				continue
			}
			attributes, ok := message["resultData"].(map[string]interface{})
			if !ok {
				continue
			}
			node := t.nodes[id]
			if node == nil {
				if len(t.nodes) >= 5000 {
					return wire.Fail(wire.NativeLimit)
				}
				node = &axRecord{attributes: map[string]interface{}{}}
				t.nodes[id] = node
			}
			for key, value := range attributes {
				switch key {
				case "1", "3", "6", "8", "9", "21", "23", "25", "27", "28", "30", "33", "42", "45", "61", "77", "78":
				default:
					continue
				}
				if value == nil {
					if _, ok := node.attributes[key]; ok {
						delete(node.attributes, key)
						if key == "21" {
							node.frame = nil
						}
						if key == "1" {
							node.activation = nil
						}
						t.revision++
					}
					continue
				}
				if key == "21" {
					node.frame = parseAXFrame(value)
				}
				if key == "1" {
					node.activation = parseAXPoint(value)
				}
				if !reflect.DeepEqual(node.attributes[key], value) {
					node.attributes[key] = value
					t.revision++
				}
			}
		}
	}
	return nil
}
func ids(value interface{}) []uint64 {
	list, ok := value.([]interface{})
	if !ok {
		return nil
	}
	result := make([]uint64, 0, len(list))
	for _, item := range list {
		if m, ok := item.(map[string]interface{}); ok {
			item = m["objectID"]
		}
		if id, ok := unsigned(item); ok {
			result = append(result, id)
		}
	}
	return result
}
func fieldBool(value interface{}) *bool {
	b, ok := value.(bool)
	if !ok {
		return nil
	}
	return &b
}
func axText(value interface{}) string {
	s, _ := value.(string)
	if !utf8.ValidString(s) {
		return ""
	}
	r := []rune(s)
	if len(r) > 200 {
		r = r[:200]
	}
	return strings.Join(strings.Fields(string(r)), " ")
}
func axRole(a map[string]interface{}, root bool) string {
	if root {
		return "application"
	}
	if s, ok := a["45"].(string); ok {
		switch s {
		case "AXButton":
			return "button"
		case "AXStaticText":
			return "text"
		case "AXTextField", "AXSecureTextField":
			return "textField"
		case "AXSwitch":
			return "switch"
		case "AXLink":
			return "link"
		}
	}
	if r, ok := unsigned(a["45"]); ok {
		switch r {
		case 2:
			return "button"
		case 3:
			return "switch"
		case 6, 14:
			return "text"
		case 8:
			return "link"
		case 13:
			return "adjustable"
		case 15:
			return "textField"
		}
	}
	traits, _ := unsigned(a["77"])
	for _, r := range []struct {
		bit  uint
		role string
	}{{5, "key"}, {10, "searchField"}, {18, "textField"}, {53, "switch"}, {12, "adjustable"}, {1, "link"}, {0, "button"}} {
		if traits&(1<<r.bit) != 0 {
			return r.role
		}
	}
	return "other"
}
func (t *axTree) snapshot(reason string) AXSnapshot {
	snapshot := AXSnapshot{Nodes: []AXNode{}, Coverage: AXCoverage{CoordinateSpace: "unqualified", Status: "partial", Reason: reason, Received: len(t.nodes)}}
	roots := make([]uint64, 0, len(t.roots))
	for id := range t.roots {
		roots = append(roots, id)
	}
	sort.Slice(roots, func(i, j int) bool { return roots[i] < roots[j] })
	visited, active := map[uint64]bool{}, map[uint64]bool{}
	bytes := 2
	var walk func(uint64, *string, int)
	walk = func(id uint64, parent *string, depth int) {
		if active[id] || visited[id] {
			snapshot.Coverage.Cycles++
			return
		}
		node := t.nodes[id]
		if node == nil {
			snapshot.Coverage.MissingChildren++
			return
		}
		if depth >= 64 || len(snapshot.Nodes) >= 1500 {
			snapshot.Coverage.Truncated = true
			return
		}
		a := node.attributes
		label := axText(a["33"])
		if label == "" {
			label = axText(a["3"])
		}
		n := AXNode{NodeID: fmt.Sprintf("n%d", len(snapshot.Nodes)+1), Parent: parent, Depth: depth, Role: axRole(a, t.roots[id]), Label: label, Enabled: fieldBool(a["27"]), Focused: fieldBool(a["28"]), Selected: fieldBool(a["30"]), Editable: "unknown", Secure: "unknown"}
		// Native frames have no qualified coordinate space; field values are never published.
		encoded, _ := json.Marshal(n)
		size := len(encoded)
		if len(snapshot.Nodes) > 0 {
			size++
		}
		if bytes+size > 32000 {
			snapshot.Coverage.Truncated = true
			return
		}
		bytes += size
		snapshot.Nodes = append(snapshot.Nodes, n)
		visited[id] = true
		active[id] = true
		snapshot.Coverage.MissingFrames++
		children := ids(a["8"])
		if visible, ok := a["9"]; ok {
			children = ids(visible)
		}
		for _, child := range children {
			parentID := n.NodeID
			walk(child, &parentID, depth+1)
		}
		delete(active, id)
	}
	for _, id := range roots {
		walk(id, nil, 0)
	}
	snapshot.Coverage.Returned = len(snapshot.Nodes)
	snapshot.Coverage.Unreturned = len(t.nodes) - len(visited)
	if len(roots) == 1 {
		if root := t.nodes[roots[0]]; root != nil {
			bundle, ok := root.attributes["6"].(string)
			if ok && len(bundle) > 0 && len(bundle) <= 128 {
				snapshot.Foreground = &Foreground{AppID: bundle, Label: axText(root.attributes["33"])}
			}
		}
	}
	return snapshot
}

var axNumber = `[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?`
var axFramePattern = regexp.MustCompile(`^\{\{\s*(` + axNumber + `)\s*,\s*(` + axNumber + `)\s*\},\s*\{\s*(` + axNumber + `)\s*,\s*(` + axNumber + `)\s*\}\}$`)
var axPointPattern = regexp.MustCompile(`^\{\s*(` + axNumber + `)\s*,\s*(` + axNumber + `)\s*\}$`)

func axNumbers(value interface{}, pattern *regexp.Regexp) []float64 {
	text, ok := value.(string)
	if !ok || len(text) > 256 {
		return nil
	}
	match := pattern.FindStringSubmatch(text)
	if match == nil {
		return nil
	}
	values := make([]float64, len(match)-1)
	for i, s := range match[1:] {
		v, e := strconv.ParseFloat(s, 64)
		if e != nil || !finite(v) {
			return nil
		}
		values[i] = v
	}
	return values
}
func parseAXFrame(value interface{}) *AXFrame {
	values := axNumbers(value, axFramePattern)
	if len(values) != 4 || values[2] <= 0 || values[3] <= 0 {
		return nil
	}
	return &AXFrame{X: values[0], Y: values[1], Width: values[2], Height: values[3]}
}
func parseAXPoint(value interface{}) *wire.Point {
	values := axNumbers(value, axPointPattern)
	if len(values) != 2 {
		return nil
	}
	return &wire.Point{X: values[0], Y: values[1]}
}

func axDecodedBudget(value interface{}, remaining *int, depth int) bool {
	if depth > 64 || *remaining < 0 {
		return false
	}
	switch v := value.(type) {
	case string:
		*remaining -= len(v)
	case []byte:
		*remaining -= len(v)
	case []interface{}:
		for _, item := range v {
			if !axDecodedBudget(item, remaining, depth+1) {
				return false
			}
		}
	case map[string]interface{}:
		for key, item := range v {
			*remaining -= len(key)
			if !axDecodedBudget(item, remaining, depth+1) {
				return false
			}
		}
	default:
		*remaining -= 8
	}
	return *remaining >= 0
}
