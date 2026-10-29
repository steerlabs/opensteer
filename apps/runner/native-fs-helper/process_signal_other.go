//go:build !linux

package main

import "errors"

func runtimePidfdSignalProbe() error {
	return errors.New("pidfd signal probe requires Linux")
}
