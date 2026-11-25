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

// Only a signal the supervisor did not send is reported: a SIGKILL during its own graceful stop
// is another's (the kernel's, for memory), its own force is not, nor a target's exit(137).
func TestSignalNotSentTellsAnotherSignalFromTheSupervisorsOwn(t *testing.T) {
	killed := exec.Command("/bin/sh", "-c", "kill -9 $$").Run()
	terminated := exec.Command("/bin/sh", "-c", "kill -15 $$").Run()
	exited := exec.Command("/bin/sh", "-c", "exit 137").Run()
	for _, check := range []struct {
		name   string
		result error
		sent   sentStops
		want   int
	}{
		{"a SIGKILL it never sent", killed, sentStops{}, 9},
		{"a SIGKILL during its graceful stop", killed, sentStops{graceful: true}, 9},
		{"its own force", killed, sentStops{graceful: true, force: true}, 0},
		{"its own graceful SIGTERM", terminated, sentStops{graceful: true}, 0},
		{"a SIGTERM it never sent", terminated, sentStops{force: true}, 15},
		{"a target's own exit 137", exited, sentStops{}, 0},
		{"a target that succeeded", nil, sentStops{}, 0},
	} {
		if got := signalNotSent(check.result, check.sent); got != check.want {
			t.Errorf("%s: signalNotSent = %d, want %d", check.name, got, check.want)
		}
	}
	if code := targetExitCode(exited); code != 137 {
		t.Fatalf("a target that exited 137 exited %d, want 137", code)
	}
}
