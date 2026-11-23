package nskeyedarchiver

import (
	"errors"
	"fmt"
	"sort"

	"howett.net/plist"
)

var ErrArchive = errors.New("invalid or oversized keyed archive")

// AX custom classes are inert dictionaries; no Objective-C factory is invoked.
func Unarchive(data []byte) ([]interface{}, error) {
	if !boundedBinaryPlist(data) {
		return nil, ErrArchive
	}
	var archive map[string]interface{}
	if _, err := plist.Unmarshal(data, &archive); err != nil {
		return nil, ErrArchive
	}
	if archive["$archiver"] != "NSKeyedArchiver" || archive["$version"] != uint64(100000) {
		return nil, ErrArchive
	}
	objects, ok := archive["$objects"].([]interface{})
	if !ok || len(objects) > 50000 {
		return nil, ErrArchive
	}
	top, ok := archive["$top"].(map[string]interface{})
	if !ok {
		return nil, ErrArchive
	}
	budget := 500000
	memo := map[plist.UID]interface{}{}
	var resolve func(interface{}, int, map[plist.UID]bool) (interface{}, error)
	resolve = func(v interface{}, depth int, chain map[plist.UID]bool) (interface{}, error) {
		budget--
		if budget < 0 || depth > 256 {
			return nil, ErrArchive
		}
		switch x := v.(type) {
		case plist.UID:
			if uint64(x) >= uint64(len(objects)) || chain[x] {
				return nil, ErrArchive
			}
			if x == 0 && objects[0] == "$null" {
				return nil, nil
			}
			if cached, ok := memo[x]; ok {
				return cached, nil
			}
			chain[x] = true
			result, e := resolve(objects[x], depth+1, chain)
			delete(chain, x)
			if e == nil {
				memo[x] = result
			}
			return result, e
		case []interface{}:
			result := make([]interface{}, len(x))
			for i, val := range x {
				r, e := resolve(val, depth+1, chain)
				if e != nil {
					return nil, e
				}
				result[i] = r
			}
			return result, nil
		case map[string]interface{}:
			r := map[string]interface{}{}
			for k, val := range x {
				if k == "$class" {
					continue
				}
				item, e := resolve(val, depth+1, chain)
				if e != nil {
					return nil, e
				}
				r[k] = item
			}
			if keys, ok := r["NS.keys"].([]interface{}); ok {
				values, ok := r["NS.objects"].([]interface{})
				if !ok || len(keys) != len(values) {
					return nil, ErrArchive
				}
				m := map[string]interface{}{}
				for i, key := range keys {
					var k string
					switch n := key.(type) {
					case string:
						k = n
					case uint64:
						k = fmt.Sprint(n)
					case int64:
						k = fmt.Sprint(n)
					default:
						return nil, ErrArchive
					}
					if _, exists := m[k]; exists {
						return nil, ErrArchive
					}
					m[k] = values[i]
				}
				return m, nil
			}
			if values, ok := r["NS.objects"]; ok {
				return values, nil
			}
			for _, key := range []string{"NS.data", "NS.string", "NS.rectval", "NS.pointval", "NS.sizeval", "NS.intval", "NS.boolval", "NS.real"} {
				if val, ok := r[key]; ok {
					return val, nil
				}
			}
			return r, nil
		default:
			return v, nil
		}
	}
	root, ok := top["root"].(plist.UID)
	if !ok {
		return nil, ErrArchive
	}
	result, e := resolve(root, 0, map[plist.UID]bool{})
	if e != nil {
		return nil, e
	}
	return []interface{}{result}, nil
}

// The encoder is the primitive/NSArray/NSDictionary subset of go-ios's archiver.
func ArchiveBin(v interface{}) ([]byte, error) {
	objects := []interface{}{"$null"}
	var archive func(interface{}, int) (plist.UID, error)
	add := func(v interface{}) plist.UID { objects = append(objects, v); return plist.UID(len(objects) - 1) }
	archive = func(v interface{}, depth int) (plist.UID, error) {
		if depth > 64 || len(objects) > 50000 {
			return 0, ErrArchive
		}
		switch x := v.(type) {
		case nil:
			return 0, nil
		case string, bool, uint64, int64, int, float64, []byte:
			return add(x), nil
		case []interface{}:
			refs := make([]interface{}, len(x))
			for i, val := range x {
				uid, e := archive(val, depth+1)
				if e != nil {
					return 0, e
				}
				refs[i] = uid
			}
			class := add(map[string]interface{}{"$classname": "NSArray", "$classes": []interface{}{"NSArray", "NSObject"}})
			return add(map[string]interface{}{"$class": class, "NS.objects": refs}), nil
		case map[string]interface{}:
			keys := make([]string, 0, len(x))
			for k := range x {
				keys = append(keys, k)
			}
			sort.Strings(keys)
			kr, vr := make([]interface{}, 0, len(x)), make([]interface{}, 0, len(x))
			for _, k := range keys {
				ki, e := archive(k, depth+1)
				if e != nil {
					return 0, e
				}
				vi, e := archive(x[k], depth+1)
				if e != nil {
					return 0, e
				}
				kr = append(kr, ki)
				vr = append(vr, vi)
			}
			class := add(map[string]interface{}{"$classname": "NSDictionary", "$classes": []interface{}{"NSDictionary", "NSObject"}})
			return add(map[string]interface{}{"$class": class, "NS.keys": kr, "NS.objects": vr}), nil
		default:
			return 0, ErrArchive
		}
	}
	root, e := archive(v, 0)
	if e != nil {
		return nil, e
	}
	return plist.Marshal(map[string]interface{}{"$version": uint64(100000), "$archiver": "NSKeyedArchiver", "$top": map[string]interface{}{"root": root}, "$objects": objects}, plist.BinaryFormat)
}
