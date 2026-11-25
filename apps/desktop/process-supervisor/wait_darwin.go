//go:build darwin

package main

import (
	"syscall"
	"unsafe"
)

const (
	darwinProcessID  = 1
	darwinWaitNoHang = 0x01
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

// Whether the process has already ended, without reaping it or waiting for it: a stop sent to a
// target that is already a zombie did not end it.
func endedWithoutReaping(processID int) bool {
	var information [16]uint64
	_, _, callError := syscall.Syscall6(
		syscall.SYS_WAITID,
		darwinProcessID,
		uintptr(processID),
		uintptr(unsafe.Pointer(&information[0])),
		darwinWaitExited|darwinWaitNow|darwinWaitNoHang,
		0,
		0,
	)
	// With WNOHANG and nothing to report, waitid leaves the zeroed siginfo as it was: si_signo,
	// the first int, stays 0.
	return callError == 0 && uint32(information[0]) != 0
}

func enableChildSubreaper() error {
	return nil
}

func signalSubreaperDescendants(_ int, _ syscall.Signal) error {
	return nil
}

func subreaperDescendantsEmpty(_ int) (bool, error) {
	return true, nil
}

func reapAdoptedChildren(_ int) {}
