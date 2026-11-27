//go:build linux

package main

import (
	"os/exec"
	"syscall"
	"testing"
	"time"
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
	defer func() {
		_ = child.Process.Kill()
		_ = child.Wait()
	}()
	if endedWithoutReaping(child.Process.Pid) {
		t.Fatal("a running child read as ended")
	}
	if err := child.Process.Signal(syscall.SIGKILL); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for !endedWithoutReaping(child.Process.Pid) {
		if time.Now().After(deadline) {
			t.Fatal("a SIGKILLed child never read as ended")
		}
		time.Sleep(time.Millisecond)
	}
	// Not reaped: its exit is still there for the supervisor to take.
	var status syscall.WaitStatus
	if pid, err := syscall.Wait4(child.Process.Pid, &status, syscall.WNOHANG, nil); err != nil || pid != child.Process.Pid || status.Signal() != syscall.SIGKILL {
		t.Fatalf("Wait4 = %d, %v, %v; want the SIGKILLed child", pid, err, status)
	}
}
