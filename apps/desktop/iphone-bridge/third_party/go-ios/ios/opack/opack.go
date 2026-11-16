package opack

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"io"
	"math"
	"reflect"
	"unicode/utf8"
)

func Encode(m map[string]interface{}) ([]byte, error) {
	buf := bytes.NewBuffer(nil)
	err := encodeDict(buf, m)
	if err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func encodeDict(w io.Writer, d map[string]interface{}) error {
	l := len(d)
	if l > 0xF {
		return fmt.Errorf("%d exceeds max size of 0xF", l)
	}
	b := 0xE0 | uint8(l)
	_, err := w.Write([]byte{b})
	if err != nil {
		return err
	}
	for k, e := range d {
		err := encodeString(w, k)
		if err != nil {
			return err
		}
		switch t := e.(type) {
		case string:
			err := encodeString(w, e.(string))
			if err != nil {
				return err
			}
		case []byte:
			err := encodeData(w, e.([]byte))
			if err != nil {
				return err
			}
		default:
			return fmt.Errorf("can't encode type %s", t)
		}
	}
	return nil
}

func encodeString(w io.Writer, s string) error {
	err := writeLengthBasedIdentifier(w, 0x40, len(s))
	if err != nil {
		return err
	}
	_, err = w.Write([]byte(s))
	return err
}

func encodeData(w io.Writer, b []byte) error {
	err := writeLengthBasedIdentifier(w, 0x70, len(b))
	if err != nil {
		return err
	}
	_, err = w.Write(b)
	return err
}

func createIdentifierWithLength(t byte, l int) ([]byte, error) {
	if l <= 0xF {
		return []byte{t | byte(l)}, nil
	} else if l < 0x20 {
		inc := t + (1 << 4)
		return []byte{inc | (byte(l) & 0xF)}, nil
	} else if l <= 0xFF {
		inc := (t + (2 << 4)) | 0x1
		return []byte{inc, byte(l)}, nil
	} else {
		return nil, fmt.Errorf("string too long: %d", l)
	}
}

func writeLengthBasedIdentifier(w io.Writer, t byte, l int) error {
	id, err := createIdentifierWithLength(t, l)
	if err != nil {
		return err
	}
	_, err = w.Write(id)
	return err
}

// DecodePairingInfo bounds both nesting and references before retaining paired identity data.
func DecodePairingInfo(b []byte) (map[string]interface{}, error) {
	if len(b) == 0 || len(b) > 8192 {
		return nil, io.ErrUnexpectedEOF
	}
	d := pairingDecoder{data: b}
	value, err := d.atom(0)
	if err != nil {
		return nil, err
	}
	result, ok := value.(map[string]interface{})
	if !ok || len(d.data) != 0 {
		return nil, fmt.Errorf("invalid pairing info dictionary")
	}
	return result, nil
}

type pairingDecoder struct {
	data    []byte
	objects []interface{}
	nodes   int
}

func (d *pairingDecoder) take(n int) ([]byte, error) {
	if n < 0 || len(d.data) < n {
		return nil, io.ErrUnexpectedEOF
	}
	v := d.data[:n]
	d.data = d.data[n:]
	return v, nil
}
func (d *pairingDecoder) number(n int) (uint64, error) {
	b, err := d.take(n)
	if err != nil {
		return 0, err
	}
	var value uint64
	for i, v := range b {
		value |= uint64(v) << uint(8*i)
	}
	return value, nil
}
func (d *pairingDecoder) remember(v interface{}) interface{} {
	for _, old := range d.objects {
		if reflect.DeepEqual(old, v) {
			return v
		}
	}
	d.objects = append(d.objects, v)
	return v
}
func (d *pairingDecoder) atom(depth int) (interface{}, error) {
	d.nodes++
	if depth > 8 || d.nodes > 512 {
		return nil, fmt.Errorf("pairing info limit exceeded")
	}
	b, err := d.take(1)
	if err != nil {
		return nil, err
	}
	tag := b[0]
	switch {
	case tag == 1:
		return true, nil
	case tag == 2:
		return false, nil
	case tag >= 8 && tag <= 0x2f:
		return uint64(tag - 8), nil
	case tag >= 0x30 && tag <= 0x33:
		value, err := d.number(1 << uint(tag-0x30))
		if err != nil {
			return nil, err
		}
		return d.remember(value), nil
	case tag == 0x35 || tag == 0x36:
		size := 4
		if tag == 0x36 {
			size = 8
		}
		b, err := d.take(size)
		if err != nil {
			return nil, err
		}
		var value float64
		if size == 4 {
			value = float64(math.Float32frombits(binary.BigEndian.Uint32(b)))
		} else {
			value = math.Float64frombits(binary.BigEndian.Uint64(b))
		}
		if math.IsNaN(value) || math.IsInf(value, 0) {
			return nil, fmt.Errorf("invalid pairing number")
		}
		return d.remember(value), nil
	case (tag >= 0x40 && tag <= 0x64) || (tag >= 0x70 && tag <= 0x94):
		base := byte(0x40)
		if tag >= 0x70 {
			base = 0x70
		}
		n := uint64(tag - base)
		if n > 32 {
			n, err = d.number(1 << uint(n-33))
			if err != nil {
				return nil, err
			}
		}
		if n > 8192 {
			return nil, io.ErrUnexpectedEOF
		}
		b, err := d.take(int(n))
		if err != nil {
			return nil, err
		}
		if base == 0x70 {
			return d.remember(append([]byte{}, b...)), nil
		}
		if !utf8.Valid(b) {
			return nil, fmt.Errorf("invalid pairing string")
		}
		return d.remember(string(b)), nil
	case tag >= 0xa0 && tag <= 0xc4:
		index := uint64(tag - 0xa0)
		if tag > 0xc0 {
			index, err = d.number(1 << uint(tag-0xc1))
			if err != nil {
				return nil, err
			}
		}
		if index >= uint64(len(d.objects)) {
			return nil, fmt.Errorf("invalid pairing reference")
		}
		return d.objects[index], nil
	case tag >= 0xd0 && tag <= 0xef:
		count := int(tag & 15)
		indefinite := count == 15
		dictionary := tag >= 0xe0
		entries := map[string]interface{}{}
		array := []interface{}{}
		for i := 0; indefinite || i < count; i++ {
			if indefinite && len(d.data) > 0 && d.data[0] == 3 {
				d.data = d.data[1:]
				break
			}
			first, err := d.atom(depth + 1)
			if err != nil {
				return nil, err
			}
			if dictionary {
				key, ok := first.(string)
				if !ok {
					return nil, fmt.Errorf("invalid pairing key")
				}
				if _, exists := entries[key]; exists {
					return nil, fmt.Errorf("duplicate pairing key")
				}
				value, err := d.atom(depth + 1)
				if err != nil {
					return nil, err
				}
				entries[key] = value
			} else {
				array = append(array, first)
			}
		}
		if dictionary {
			return entries, nil
		}
		return array, nil
	default:
		return nil, fmt.Errorf("unsupported pairing info atom")
	}
}
