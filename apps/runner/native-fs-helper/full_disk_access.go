package main

import (
	"errors"
	"fmt"
	"io"
)

const (
	fullDiskAccessGranted = "granted"
	fullDiskAccessDenied  = "denied"
)

// The verb takes no arguments: the answer is a property of the app this
// process descends from, so there is nothing for a caller to name.
func runFullDiskAccess(arguments []string, output io.Writer) error {
	if len(arguments) != 0 {
		return errors.New("usage: opensteer-native-fs full-disk-access")
	}
	answer, err := probeFullDiskAccess()
	if err != nil {
		return err
	}
	_, err = fmt.Fprintln(output, answer)
	return err
}
