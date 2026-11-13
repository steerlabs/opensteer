//go:build windows

package main

import (
	"errors"
	"fmt"
	"os"
	"unsafe"

	"golang.org/x/sys/windows"
)

// startupInformation is STARTUPINFOW. x/sys's StartupInfo hides the
// cbReserved2/lpReserved2 fields that carry the CRT handle block.
type startupInformation struct {
	size          uint32
	reserved      *uint16
	desktop       *uint16
	title         *uint16
	x             uint32
	y             uint32
	xSize         uint32
	ySize         uint32
	xCountChars   uint32
	yCountChars   uint32
	fillAttribute uint32
	flags         uint32
	showWindow    uint16
	reserved2Size uint16
	reserved2     *byte
	stdInput      windows.Handle
	stdOutput     windows.Handle
	stdError      windows.Handle
}

var procedureGetStartupInfo = kernel32.NewProc("GetStartupInfoW")

func openControlChannel() (*os.File, error) {
	information := startupInformation{}
	information.size = uint32(unsafe.Sizeof(information))
	procedureGetStartupInfo.Call(uintptr(unsafe.Pointer(&information)))
	if information.reserved2 == nil || information.reserved2Size == 0 {
		return nil, errors.New("no inherited handle block in the startup information")
	}
	block := unsafe.Slice(information.reserved2, information.reserved2Size)
	value, err := crtInheritedPipe(block, controlFileDescriptor, int(unsafe.Sizeof(uintptr(0))))
	if err != nil {
		return nil, err
	}
	handle := windows.Handle(uintptr(value))
	fileType, err := windows.GetFileType(handle)
	if err != nil {
		return nil, fmt.Errorf("inherited control handle is unusable: %w", err)
	}
	if fileType != windows.FILE_TYPE_PIPE {
		return nil, fmt.Errorf("inherited control handle is not a pipe (type %d)", fileType)
	}
	if err := windows.SetHandleInformation(handle, windows.HANDLE_FLAG_INHERIT, 0); err != nil {
		return nil, fmt.Errorf("inherited control handle inheritance could not be cleared: %w", err)
	}
	return os.NewFile(uintptr(handle), "opensteer-process-control"), nil
}
