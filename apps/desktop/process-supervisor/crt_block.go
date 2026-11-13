package main

import (
	"encoding/binary"
	"errors"
	"fmt"
)

// The MSVC CRT handle block (STARTUPINFOW.lpReserved2) is a little-endian
// int32 count, then count flag bytes, then count packed, unaligned
// pointer-sized handles. libuv writes it for every child it spawns and
// supports at most 255 entries.
const (
	crtBlockMaximumEntries = 255
	crtFlagOpen            = 0x01
	crtFlagPipe            = 0x08
)

func crtInheritedPipe(block []byte, index int, pointerSize int) (uint64, error) {
	if pointerSize != 4 && pointerSize != 8 {
		return 0, fmt.Errorf("unsupported pointer size %d", pointerSize)
	}
	if len(block) < 4 {
		return 0, errors.New("inherited handle block is missing or truncated")
	}
	count := int64(int32(binary.LittleEndian.Uint32(block)))
	if count <= int64(index) {
		return 0, fmt.Errorf("inherited handle block has %d entries, need more than %d", count, index)
	}
	if count > crtBlockMaximumEntries {
		return 0, fmt.Errorf("inherited handle block claims %d entries", count)
	}
	// count is bounded above, so this cannot overflow.
	required := 4 + count + count*int64(pointerSize)
	if int64(len(block)) < required {
		return 0, fmt.Errorf("inherited handle block is %d bytes, need %d", len(block), required)
	}
	flags := block[4+index]
	if flags&crtFlagOpen == 0 || flags&crtFlagPipe == 0 {
		return 0, fmt.Errorf("inherited entry %d is not an open pipe (flags %#x)", index, flags)
	}
	offset := 4 + count + int64(index)*int64(pointerSize)
	var handle, invalid uint64
	if pointerSize == 8 {
		handle, invalid = binary.LittleEndian.Uint64(block[offset:]), ^uint64(0)
	} else {
		handle, invalid = uint64(binary.LittleEndian.Uint32(block[offset:])), uint64(^uint32(0))
	}
	if handle == 0 || handle == invalid {
		return 0, fmt.Errorf("inherited entry %d has no handle", index)
	}
	return handle, nil
}
