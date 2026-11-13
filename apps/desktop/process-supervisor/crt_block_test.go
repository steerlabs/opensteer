package main

import (
	"encoding/binary"
	"strings"
	"testing"
)

func crtBlock(count int32, pointerSize int, flags []byte, handles []uint64) []byte {
	block := binary.LittleEndian.AppendUint32(nil, uint32(count))
	block = append(block, flags...)
	for _, handle := range handles {
		if pointerSize == 8 {
			block = binary.LittleEndian.AppendUint64(block, handle)
		} else {
			block = binary.LittleEndian.AppendUint32(block, uint32(handle))
		}
	}
	return block
}

func TestCrtInheritedPipeDecodesPackedUnalignedHandles(t *testing.T) {
	open := byte(crtFlagOpen | crtFlagPipe)
	for _, pointerSize := range []int{4, 8} {
		// Five entries put the handle array at offset 9, so entry 3 is unaligned.
		block := crtBlock(5, pointerSize, []byte{0, open, open, open, 0}, []uint64{^uint64(0), 0x11, 0x22, 0x1234, ^uint64(0)})
		handle, err := crtInheritedPipe(block, 3, pointerSize)
		if err != nil || handle != 0x1234 {
			t.Fatalf("pointer size %d: got %#x, %v; want 0x1234", pointerSize, handle, err)
		}
		// A larger block than the entries need is accepted.
		if handle, err := crtInheritedPipe(append(block, 0, 0, 0), 3, pointerSize); err != nil || handle != 0x1234 {
			t.Fatalf("pointer size %d with padding: got %#x, %v", pointerSize, handle, err)
		}
	}
	block := crtBlock(4, 8, []byte{0, 0, 0, open}, []uint64{0, 0, 0, 0x0102030405060708})
	if handle, err := crtInheritedPipe(block, 3, 8); err != nil || handle != 0x0102030405060708 {
		t.Fatalf("got %#x, %v; want the full 64-bit handle", handle, err)
	}
}

func TestCrtInheritedPipeRejectsMalformedBlocks(t *testing.T) {
	open := byte(crtFlagOpen | crtFlagPipe)
	valid := func(pointerSize int) []byte {
		return crtBlock(4, pointerSize, []byte{0, 0, 0, open}, []uint64{0, 0, 0, 0x44})
	}
	tests := []struct {
		name        string
		block       []byte
		pointerSize int
		want        string
	}{
		{"missing", nil, 8, "missing or truncated"},
		{"short count", []byte{4, 0}, 8, "missing or truncated"},
		{"too few entries", crtBlock(3, 8, []byte{open, open, open}, []uint64{1, 2, 3}), 8, "need more than 3"},
		{"negative count", crtBlock(-1, 8, nil, nil), 8, "need more than 3"},
		{"oversized count", crtBlock(256, 8, make([]byte, 256), make([]uint64, 256)), 8, "claims 256 entries"},
		{"huge count", crtBlock(0x7fffffff, 8, nil, nil), 8, "claims"},
		{"truncated handles", valid(8)[:len(valid(8))-1], 8, "need 40"},
		{"truncated 32-bit handles", valid(4)[:len(valid(4))-1], 4, "need 24"},
		{"not open", crtBlock(4, 8, []byte{0, 0, 0, crtFlagPipe}, []uint64{0, 0, 0, 0x44}), 8, "not an open pipe"},
		{"not a pipe", crtBlock(4, 8, []byte{0, 0, 0, crtFlagOpen}, []uint64{0, 0, 0, 0x44}), 8, "not an open pipe"},
		{"null handle", crtBlock(4, 8, []byte{0, 0, 0, open}, []uint64{0, 0, 0, 0}), 8, "no handle"},
		{"invalid handle", crtBlock(4, 8, []byte{0, 0, 0, open}, []uint64{0, 0, 0, ^uint64(0)}), 8, "no handle"},
		{"invalid 32-bit handle", crtBlock(4, 4, []byte{0, 0, 0, open}, []uint64{0, 0, 0, 0xffffffff}), 4, "no handle"},
		{"pointer size", valid(8), 2, "unsupported pointer size"},
	}
	for _, test := range tests {
		handle, err := crtInheritedPipe(test.block, 3, test.pointerSize)
		if err == nil || !strings.Contains(err.Error(), test.want) {
			t.Fatalf("%s: got %#x, %v; want error containing %q", test.name, handle, err, test.want)
		}
	}
}
