//go:build darwin || linux

package main

import (
	"os/exec"
	"testing"
)

// A target a signal ended reports 128 and its number, so a Runner can tell the kernel's kill for
// memory (SIGKILL, 137) from an ordinary failure, which stays its own code.
func TestTargetExitCodeReportsASignalLikeAShell(t *testing.T) {
	killed := exec.Command("/bin/sh", "-c", "kill -9 $$").Run()
	if code := targetExitCode(killed); code != 137 {
		t.Fatalf("a target ended by SIGKILL exited %d, want 137", code)
	}
	failed := exec.Command("/bin/sh", "-c", "exit 3").Run()
	if code := targetExitCode(failed); code != 3 {
		t.Fatalf("a target that exited 3 exited %d, want 3", code)
	}
	if code := targetExitCode(nil); code != 0 {
		t.Fatalf("a target that succeeded exited %d, want 0", code)
	}
}
