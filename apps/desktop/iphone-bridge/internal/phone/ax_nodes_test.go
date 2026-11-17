package phone

import (
	"encoding/binary"
	"encoding/json"
	"strings"
	"testing"

	"github.com/danielpaulus/go-ios/ios/nskeyedarchiver"
	"howett.net/plist"
)

func axUpdate(kind uint64, data map[string]interface{}) map[string]interface{} {
	return map[string]interface{}{"associatedRequestType": kind, "resultData": data}
}
func axAttributes(id uint64, attributes map[string]interface{}) map[string]interface{} {
	m := axUpdate(5, attributes)
	m["associatedTranslationObject"] = map[string]interface{}{"objectID": id}
	return m
}
func axDump(items ...map[string]interface{}) map[string]interface{} {
	list := make([]interface{}, len(items))
	for i, m := range items {
		list[i] = m
	}
	return axUpdate(11, map[string]interface{}{"treeDump": list})
}
func TestAXIncrementalMergeOrderingVisibilityAndRedaction(t *testing.T) {
	root := axUpdate(4, map[string]interface{}{"objectID": uint64(1), "pid": uint64(99)})
	a := axAttributes(1, map[string]interface{}{"8": []interface{}{uint64(2), uint64(3)}, "6": "fixture.app", "33": "Fixture"})
	b := axAttributes(2, map[string]interface{}{"33": "Field", "45": "AXSecureTextField", "53": "sentinel-secret-value", "21": "{{10,20},{40,30}}", "8": []interface{}{uint64(1)}})
	missing := axAttributes(3, map[string]interface{}{"3": "Old", "33": "Preferred", "8": []interface{}{uint64(404)}})
	for _, order := range [][]map[string]interface{}{{root, a, b, missing}, {missing, b, a, root}} {
		tree := newAXTree()
		for _, item := range order {
			inner, e := nskeyedarchiver.ArchiveBin(axDump(item))
			if e != nil {
				t.Fatal(e)
			}
			outer, e := nskeyedarchiver.ArchiveBin(inner)
			if e != nil {
				t.Fatal(e)
			}
			if e = tree.archive(outer); e != nil {
				t.Fatal(e)
			}
		}
		rev := tree.revision
		if e := tree.merge(axDump(root, a, b, missing)); e != nil {
			t.Fatal(e)
		}
		if tree.revision != rev {
			t.Fatal("duplicate callback changed revision")
		}
		snapshot := tree.snapshot("quiet-window")
		if len(snapshot.Nodes) != 3 || snapshot.Nodes[1].Parent == nil || *snapshot.Nodes[1].Parent != "n1" || snapshot.Coverage.Cycles != 1 || snapshot.Coverage.MissingChildren != 1 || snapshot.Nodes[2].Label != "Preferred" {
			t.Fatalf("lost hierarchy: %+v", snapshot)
		}
		encoded, _ := json.Marshal(snapshot)
		if strings.Contains(string(encoded), "sentinel") || snapshot.Nodes[1].Frame != nil || snapshot.Nodes[1].Secure != "unknown" {
			t.Fatal("unqualified field value/frame escaped")
		}
		if err := tree.merge(axDump(axAttributes(1, map[string]interface{}{"9": []interface{}{}}))); err != nil {
			t.Fatal(err)
		}
		snapshot = tree.snapshot("quiet-window")
		if len(snapshot.Nodes) != 1 || snapshot.Coverage.Unreturned != 2 {
			t.Fatal("empty visible children fell back to all children")
		}
		if err := tree.merge(axDump(axAttributes(3, map[string]interface{}{"33": nil}))); err != nil {
			t.Fatal(err)
		}
		if tree.nodes[3].attributes["33"] != nil {
			t.Fatal("deleted attribute retained")
		}
	}
}
func TestAXDoesNotBuildTreeFromAuditOrUnrootedNodes(t *testing.T) {
	tree := newAXTree()
	if err := tree.merge(map[string]interface{}{"auditIssues": []interface{}{map[string]interface{}{"label": "Issue"}}}); err != nil {
		t.Fatal(err)
	}
	if tree.usable() {
		t.Fatal("audit issues synthesized hierarchy")
	}
	if err := tree.merge(axDump(axAttributes(1, map[string]interface{}{"33": "Unrooted"}), axAttributes(2, map[string]interface{}{"33": "Unrooted2"}))); err != nil {
		t.Fatal(err)
	}
	if tree.usable() {
		t.Fatal("unrooted attributes became hierarchy")
	}
}
func TestAXArchiveUnknownClassesAreInertAndCyclesBounded(t *testing.T) {
	encode := func(objects []interface{}) []byte {
		b, e := plist.Marshal(map[string]interface{}{"$archiver": "NSKeyedArchiver", "$version": uint64(100000), "$objects": objects, "$top": map[string]interface{}{"root": plist.UID(1)}}, plist.BinaryFormat)
		if e != nil {
			t.Fatal(e)
		}
		return b
	}
	unknown := encode([]interface{}{"$null", map[string]interface{}{"$class": plist.UID(2), "objectID": uint64(12)}, map[string]interface{}{"$classname": "UnknownInertAXClass"}})
	decoded, e := nskeyedarchiver.Unarchive(unknown)
	if e != nil || decoded[0].(map[string]interface{})["objectID"] != uint64(12) {
		t.Fatalf("inert class decoding: %v", e)
	}
	cyclic := encode([]interface{}{"$null", map[string]interface{}{"next": plist.UID(1)}})
	if _, e := nskeyedarchiver.Unarchive(cyclic); e == nil {
		t.Fatal("UID cycle accepted")
	}
	data := encode([]interface{}{"$null", "root"})
	binary.BigEndian.PutUint64(data[len(data)-24:], ^uint64(0))
	if _, e := nskeyedarchiver.Unarchive(data); e == nil {
		t.Fatal("oversized trailer accepted")
	}
	var nested interface{} = "leaf"
	for range 70 {
		nested = map[string]interface{}{"next": nested}
	}
	if _, e := nskeyedarchiver.ArchiveBin(nested); e == nil {
		t.Fatal("deep archive accepted")
	}
}
func TestAXGeometryRequiresExactFiniteGrammar(t *testing.T) {
	if parseAXFrame("{{10,20},{30.5,4e1}}") == nil || parseAXPoint("{1,2}") == nil {
		t.Fatal("valid geometry rejected")
	}
	for _, value := range []string{"arbitrary 10 20 30 40", "{{NaN,20},{30,40}}", "{{10,20},{-30,40}}", "{{10,20},{30,40}} trailing", "{{10,20},{1e999,40}}"} {
		if parseAXFrame(value) != nil {
			t.Fatalf("invalid geometry accepted: %s", value)
		}
	}
}

func TestAXOutputAndExpandedInputHaveSeparateBounds(t *testing.T) {
	tree := newAXTree()
	children := []interface{}{}
	for i := uint64(2); i < 302; i++ {
		children = append(children, i)
		if e := tree.merge(axDump(axAttributes(i, map[string]interface{}{"33": strings.Repeat("🔐", 200)}))); e != nil {
			t.Fatal(e)
		}
	}
	if e := tree.merge(axDump(axUpdate(4, map[string]interface{}{"objectID": uint64(1)}), axAttributes(1, map[string]interface{}{"8": children}))); e != nil {
		t.Fatal(e)
	}
	snapshot := tree.snapshot("quiet-window")
	encoded, e := json.Marshal(snapshot.Nodes)
	if e != nil {
		t.Fatal(e)
	}
	if len(encoded) > 32000 || !snapshot.Coverage.Truncated || snapshot.Coverage.Unreturned == 0 {
		t.Fatal("UTF-8 output cap not enforced")
	}
	remaining := 1024
	value := strings.Repeat("x", 513)
	if axDecodedBudget([]interface{}{value, value}, &remaining, 0) {
		t.Fatal("expanded callback budget not enforced")
	}
}
func TestAXBinaryContainerPreflightBoundsExpansionAndCounts(t *testing.T) {
	document := func(objects []byte, offsets []byte) []byte {
		data := append([]byte("bplist00"), objects...)
		table := len(data)
		data = append(data, offsets...)
		var trailer [32]byte
		trailer[6] = 1
		trailer[7] = 1
		binary.BigEndian.PutUint64(trailer[8:], uint64(len(offsets)))
		binary.BigEndian.PutUint64(trailer[24:], uint64(table))
		return append(data, trailer[:]...)
	}
	// A UTF-16 count that would overflow the dependency's byte multiplication.
	large := []byte{0x6f, 0x13}
	var count [8]byte
	binary.BigEndian.PutUint64(count[:], 1<<63)
	large = append(large, count[:]...)
	if _, e := nskeyedarchiver.Unarchive(document(large, []byte{8})); e == nil {
		t.Fatal("overflowing container count accepted")
	}
	// Thirty tiny shared arrays would expand exponentially without a graph budget.
	objects, offsets := []byte{}, []byte{}
	for i := 0; i < 30; i++ {
		offsets = append(offsets, byte(8+len(objects)))
		objects = append(objects, 0xa2, byte(i+1), byte(i+1))
	}
	offsets = append(offsets, byte(8+len(objects)))
	objects = append(objects, 0x51, 'x')
	if _, e := nskeyedarchiver.Unarchive(document(objects, offsets)); e == nil {
		t.Fatal("exponential plist container expansion accepted")
	}
}
