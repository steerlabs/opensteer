//go:build darwin || linux

package main

import (
	"errors"
	"fmt"
	"os"

	"golang.org/x/sys/unix"
)

func openControlChannel() (*os.File, error) {
	control := os.NewFile(controlFileDescriptor, "opensteer-process-control")
	if control == nil {
		return nil, errors.New("file descriptor 3 is not open")
	}
	if _, err := control.Stat(); err != nil {
		control.Close()
		return nil, fmt.Errorf("file descriptor 3 is invalid: %w", err)
	}
	unix.CloseOnExec(int(control.Fd()))
	return control, nil
}
