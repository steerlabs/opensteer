//go:build !darwin

package main

import "errors"

// Nothing outside macOS gates the filesystem on an app-level grant, so there is
// no answer to give and inventing one would put a made-up fact on a descriptor.
func probeFullDiskAccess() (string, error) {
	return "", errors.New("full-disk-access is only meaningful on macOS")
}
