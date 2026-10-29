//go:build windows

package main

import (
	"errors"
	"io"
)

func runShellServe(_ io.Reader, _ io.Writer) error {
	return errors.New("shell-serve is unavailable on Windows; Opensteer shell targets require macOS or Linux")
}
