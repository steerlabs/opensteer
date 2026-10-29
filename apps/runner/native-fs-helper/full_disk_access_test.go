//go:build linux || darwin

package main

import (
	"bytes"
	"errors"
	"io"
	"os/exec"
	"runtime"
	"strings"
	"testing"
)

func TestFullDiskAccessVerbTakesNoArguments(t *testing.T) {
	if err := runFullDiskAccess([]string{"--now"}, io.Discard); err == nil ||
		err.Error() != "usage: opensteer-native-fs full-disk-access" {
		t.Fatalf("unexpected argument handling: %v", err)
	}

	_, standardError, code := runFullDiskAccessBinary(t, "full-disk-access", "--now")
	if code != 1 || !strings.Contains(standardError, "usage: opensteer-native-fs full-disk-access") {
		t.Fatalf("unexpected exit %d: %q", code, standardError)
	}
}

func TestFullDiskAccessAnswersOnMacOSOnly(t *testing.T) {
	standardOutput, standardError, code := runFullDiskAccessBinary(t, "full-disk-access")
	if runtime.GOOS != "darwin" {
		if code != 1 || !strings.Contains(standardError, "full-disk-access is only meaningful on macOS") {
			t.Fatalf("unexpected exit %d: %q", code, standardError)
		}
		return
	}
	// The value depends on whether whatever launched `go test` holds the grant,
	// so the contract under test is the vocabulary, not which word came back.
	if code != 0 || (standardOutput != "granted\n" && standardOutput != "denied\n") {
		t.Fatalf("unexpected answer (exit %d): %q %q", code, standardOutput, standardError)
	}
}

func runFullDiskAccessBinary(t *testing.T, arguments ...string) (string, string, int) {
	t.Helper()
	command := exec.Command(shellTestBinary, arguments...)
	var standardOutput, standardError bytes.Buffer
	command.Stdout = &standardOutput
	command.Stderr = &standardError
	var exit *exec.ExitError
	if err := command.Run(); err != nil && !errors.As(err, &exit) {
		t.Fatalf("%v failed: %v", arguments, err)
	}
	return standardOutput.String(), standardError.String(), command.ProcessState.ExitCode()
}
