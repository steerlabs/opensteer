//go:build linux

package main

import (
	"os/exec"
	"syscall"
	"testing"
)

func TestParseLinuxSharedPendingReadsTheThreadGroupsMask(t *testing.T) {
	status := "Name:\tnode\nState:\tZ (zombie)\nSigPnd:\t0000000000000000\nShdPnd:\t0000000000000100\nSigBlk:\t0000000000000000\n"
	pending, ok := parseLinuxSharedPending(status)
	if !ok || pending != 0x100 {
		t.Fatalf("parseLinuxSharedPending = %#x, %v; want 0x100, true", pending, ok)
	}
	if _, ok := parseLinuxSharedPending("Name:\tnode\nShdPnd:\tnot-hex\n"); ok {
		t.Fatal("a malformed ShdPnd must read as nothing known")
	}
	if _, ok := parseLinuxSharedPending("Name:\tnode\n"); ok {
		t.Fatal("a status without ShdPnd must read as nothing known")
	}
}

func TestEndedWithoutReapingTellsALiveChildFromAKilledOne(t *testing.T) {
	child := exec.Command("/bin/sleep", "30")
	if err := child.Start(); err != nil {
		t.Fatal(err)
	}
	reaped := false
	defer func() {
		if !reaped {
			_ = child.Process.Kill()
			_ = child.Wait()
		}
	}()
	if endedWithoutReaping(child.Process.Pid) {
		t.Fatal("a running child read as ended")
	}
	if err := child.Process.Signal(syscall.SIGKILL); err != nil {
		t.Fatal(err)
	}
	// At once: the SIGKILL is pending for the thread group from the moment kill returns, before
	// the child is a zombie waitid would report.
	if !endedWithoutReaping(child.Process.Pid) {
		t.Fatal("a SIGKILLed child did not read as ended")
	}
	// Not reaped: its exit is still there for the supervisor to take.
	var status syscall.WaitStatus
	pid, err := syscall.Wait4(child.Process.Pid, &status, 0, nil)
	reaped = err == nil
	if err != nil || pid != child.Process.Pid || status.Signal() != syscall.SIGKILL {
		t.Fatalf("Wait4 = %d, %v, %v; want the SIGKILLed child", pid, err, status)
	}
}
