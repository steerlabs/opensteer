package wire

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"reflect"
	"unicode/utf8"
)

const (
	MaxRequestBytes  = 256 << 10
	MaxResponseBytes = 2 << 20
	MaxEventBytes    = 64 << 10
	MaxPending       = 64
	MaxTimeoutMs     = 120000
)

var ErrProtocol = errors.New("bridge-protocol-mismatch")

func ReadFrame(r io.Reader, limit uint32) ([]byte, error) {
	var header [4]byte
	if _, err := io.ReadFull(r, header[:]); err != nil {
		return nil, err
	}
	n := binary.BigEndian.Uint32(header[:])
	if n == 0 || n > limit {
		return nil, ErrProtocol
	}
	b := make([]byte, n)
	if _, err := io.ReadFull(r, b); err != nil {
		return nil, err
	}
	if !utf8.Valid(b) {
		return nil, ErrProtocol
	}
	return b, nil
}
func WriteFrame(w io.Writer, v interface{}, limit uint32) error {
	b, err := json.Marshal(v)
	if err != nil {
		return ErrProtocol
	}
	if len(b) == 0 || uint64(len(b)) > uint64(limit) {
		return ErrProtocol
	}
	var header [4]byte
	binary.BigEndian.PutUint32(header[:], uint32(len(b)))
	if err := writeAll(w, header[:]); err != nil {
		return err
	}
	return writeAll(w, b)
}
func writeAll(w io.Writer, b []byte) error {
	for len(b) > 0 {
		n, err := w.Write(b)
		if err != nil {
			return err
		}
		if n <= 0 {
			return io.ErrShortWrite
		}
		b = b[n:]
	}
	return nil
}

// Reject duplicate members before struct decoding; encoding/json otherwise keeps the last value.
func validJSON(b []byte) error {
	if !utf8.Valid(b) {
		return ErrProtocol
	}
	d := json.NewDecoder(bytes.NewReader(b))
	d.UseNumber()
	var walk func(int) error
	walk = func(depth int) error {
		if depth > 32 {
			return ErrProtocol
		}
		token, err := d.Token()
		if err != nil {
			return ErrProtocol
		}
		if delim, ok := token.(json.Delim); ok {
			switch delim {
			case '{':
				seen := map[string]bool{}
				for d.More() {
					k, err := d.Token()
					if err != nil {
						return ErrProtocol
					}
					s, ok := k.(string)
					if !ok || seen[s] {
						return ErrProtocol
					}
					seen[s] = true
					if err := walk(depth + 1); err != nil {
						return err
					}
				}
				end, err := d.Token()
				if err != nil || end != json.Delim('}') {
					return ErrProtocol
				}
			case '[':
				for d.More() {
					if err := walk(depth + 1); err != nil {
						return err
					}
				}
				end, err := d.Token()
				if err != nil || end != json.Delim(']') {
					return ErrProtocol
				}
			default:
				return ErrProtocol
			}
		}
		return nil
	}
	if err := walk(0); err != nil {
		return err
	}
	if _, err := d.Token(); err != io.EOF {
		return ErrProtocol
	}
	return nil
}
func StrictDecode(b []byte, v interface{}) error {
	if err := validJSON(b); err != nil {
		return err
	}
	var object interface{}
	if json.Unmarshal(b, &object) != nil {
		return ErrProtocol
	}
	if !exactFields(object, reflect.TypeOf(v).Elem()) {
		return ErrProtocol
	}
	d := json.NewDecoder(bytes.NewReader(b))
	d.DisallowUnknownFields()
	if err := d.Decode(v); err != nil {
		return ErrProtocol
	}
	return nil
}

func exactFields(value interface{}, kind reflect.Type) bool {
	if kind == reflect.TypeOf(json.RawMessage{}) {
		return true
	}
	for kind.Kind() == reflect.Pointer {
		kind = kind.Elem()
	}
	if kind.Kind() != reflect.Struct {
		return true
	}
	object, ok := value.(map[string]interface{})
	if !ok {
		return false
	}
	fields := make(map[string]reflect.Type)
	var add func(reflect.Type)
	add = func(t reflect.Type) {
		for i := 0; i < t.NumField(); i++ {
			f := t.Field(i)
			if f.Anonymous {
				add(f.Type)
				continue
			}
			name := f.Tag.Get("json")
			if name != "" && name != "-" {
				fields[name] = f.Type
			}
		}
	}
	add(kind)
	for name := range fields {
		if _, ok := object[name]; !ok {
			return false
		}
	}
	for name, v := range object {
		t, ok := fields[name]
		if !ok || !exactFields(v, t) {
			return false
		}
	}
	return true
}
