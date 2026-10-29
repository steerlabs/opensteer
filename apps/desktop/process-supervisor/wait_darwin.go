//go:build darwin

package main

import (
	"syscall"
	"unsafe"
)

const (
	darwinProcessID  = 1
	darwinWaitExited = 0x04
	darwinWaitNow    = 0x20
)

// Darwin exposes waitid(2), but x/sys/unix does not wrap it. The kernel only
// writes siginfo_t; an oversized, naturally aligned opaque buffer avoids
// depending on its private field layout.
func waitWithoutReaping(processID int) error {
	var information [16]uint64
	_, _, callError := syscall.Syscall6(
		syscall.SYS_WAITID,
		darwinProcessID,
		uintptr(processID),
		uintptr(unsafe.Pointer(&information[0])),
		darwinWaitExited|darwinWaitNow,
		0,
		0,
	)
	if callError != 0 {
		return callError
	}
	return nil
}
