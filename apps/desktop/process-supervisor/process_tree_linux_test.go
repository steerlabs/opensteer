//go:build linux

package main

import (
	"bufio"
	"encoding/json"
	"os"
	"os/exec"
	"syscall"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

func TestSubreaperStopsDoubleForkedClearedEnvWorker(t *testing.T) {
	// Spawns a target that forks an intermediate child, which calls setsid() to
	// leave the process group, clears its environment, forks a grandchild worker
	// that ignores SIGTERM, reports the grandchild PID, and exits. Because the
	// supervisor enables PR_SET_CHILD_SUBREAPER on Linux, the grandchild is
	// re-parented to the supervisor instead of PID 1 and is found and killed.
	script := `
import json, os, signal, sys, time
pid = os.fork()
if pid > 0:
    os.waitpid(pid, 0)
    os._exit(0)
os.setsid()
os.environ.clear()
r, w = os.pipe()
gpid = os.fork()
if gpid == 0:
    os.close(r)
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    os.write(w, f"{os.getpid()}\n".encode())
    os.close(w)
    while True:
        time.sleep(60)
os.close(w)
data = os.read(r, 64).decode().strip()
os.close(r)
print(json.dumps({"grandchild": int(data)}), flush=True)
os._exit(0)
`
	pythonPath, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("python3 is not available")
	}
	controlReader, controlWriter, err := os.Pipe()
	if err != nil {
		t.Fatalf("create control pipe: %v", err)
	}
	t.Cleanup(func() {
		_ = controlReader.Close()
		_ = controlWriter.Close()
	})
	command := exec.Command(
		os.Args[0],
		"--opensteer-wrapper-target",
		pythonPath,
		"-c",
		script,
	)
	command.Env = replaceEnvironment(os.Environ(), helperModeEnvironment, "wrapper")
	command.ExtraFiles = []*os.File{controlReader}
	output, err := command.StdoutPipe()
	if err != nil {
		t.Fatalf("create stdout pipe: %v", err)
	}
	command.Stderr = os.Stderr
	if err := command.Start(); err != nil {
		t.Fatalf("start wrapper: %v", err)
	}
	_ = controlReader.Close()

	line, err := bufio.NewReader(output).ReadString('\n')
	if err != nil {
		t.Fatalf("read grandchild pid: %v", err)
	}
	var payload struct {
		Grandchild int `json:"grandchild"`
	}
	if err := json.Unmarshal([]byte(line), &payload); err != nil || payload.Grandchild < 1 {
		t.Fatalf("invalid grandchild payload %q: %v", line, err)
	}
	t.Cleanup(func() {
		_ = syscall.Kill(payload.Grandchild, syscall.SIGKILL)
	})

	// Root exits immediately; supervisor must find and kill the reparented grandchild
	// even though it called setsid() and cleared its environment.
	if err := waitWithDeadline(command, 5*time.Second); err != nil {
		if _, ok := err.(*exec.ExitError); !ok {
			t.Fatalf("wrapper did not terminate: %v", err)
		}
	}
	requireProcessGone(t, payload.Grandchild)
}

func TestSignalLinuxDescendantRefusesReusedPID(t *testing.T) {
	t.Run("pidfd refuses kill when startTime changed", func(t *testing.T) {
		closed := 0
		signaled := 0
		killed := 0
		s := linuxDescendantSignaler{
			selfPID: 100,
			openPidfd: func(pid int, flags int) (int, error) {
				if pid != 555 || flags != 0 {
					t.Fatalf("unexpected openPidfd(%d, %d)", pid, flags)
				}
				return 42, nil
			},
			closeFd: func(fd int) error {
				if fd != 42 {
					t.Fatalf("unexpected closeFd(%d)", fd)
				}
				closed++
				return nil
			},
			readStartTime: func(pid int) (string, error) {
				return "999999", nil // PID reused by a newer process
			},
			sendPidfdSignal: func(fd int, sig unix.Signal, info *unix.Siginfo, flags int) error {
				signaled++
				return nil
			},
			killPID: func(pid int, sig syscall.Signal) error {
				killed++
				return nil
			},
		}
		s.signalOne(linuxProcEntry{pid: 555, ppid: 200, state: 'S', startTime: "123456"}, syscall.SIGKILL)
		if closed != 1 || signaled != 0 || killed != 0 {
			t.Fatalf("expected closed=1 signaled=0 killed=0, got closed=%d signaled=%d killed=%d", closed, signaled, killed)
		}
	})

	t.Run("pidfd delivers signal when startTime matches", func(t *testing.T) {
		closed := 0
		var gotSig unix.Signal
		signaled := 0
		s := linuxDescendantSignaler{
			selfPID:   100,
			openPidfd: func(pid int, flags int) (int, error) { return 43, nil },
			closeFd:   func(fd int) error { closed++; return nil },
			readStartTime: func(pid int) (string, error) {
				return "123456", nil
			},
			sendPidfdSignal: func(fd int, sig unix.Signal, info *unix.Siginfo, flags int) error {
				if fd != 43 {
					t.Fatalf("unexpected fd %d", fd)
				}
				gotSig = sig
				signaled++
				return nil
			},
			killPID: func(pid int, sig syscall.Signal) error {
				t.Fatalf("killPID must not be used when pidfd succeeds")
				return nil
			},
		}
		s.signalOne(linuxProcEntry{pid: 555, ppid: 200, state: 'S', startTime: "123456"}, syscall.SIGKILL)
		if closed != 1 || signaled != 1 || gotSig != unix.Signal(syscall.SIGKILL) {
			t.Fatalf("expected closed=1 signaled=1 SIGKILL, got closed=%d signaled=%d sig=%v", closed, signaled, gotSig)
		}
	})

	t.Run("ENOSYS fallback signals only direct children with matching startTime", func(t *testing.T) {
		var killed []int
		currentStart := "123456"
		s := linuxDescendantSignaler{
			selfPID:         100,
			openPidfd:       func(pid int, flags int) (int, error) { return -1, unix.ENOSYS },
			closeFd:         func(fd int) error { return nil },
			readStartTime:   func(pid int) (string, error) { return currentStart, nil },
			sendPidfdSignal: func(fd int, sig unix.Signal, info *unix.Siginfo, flags int) error { return nil },
			killPID: func(pid int, sig syscall.Signal) error {
				killed = append(killed, pid)
				return nil
			},
		}
		// Non-direct grandchild: never kill without pidfd.
		s.signalOne(linuxProcEntry{pid: 601, ppid: 200, state: 'S', startTime: "123456"}, syscall.SIGKILL)
		// Direct child with mismatched startTime: never kill.
		currentStart = "999999"
		s.signalOne(linuxProcEntry{pid: 602, ppid: 100, state: 'S', startTime: "123456"}, syscall.SIGKILL)
		// Direct child with matching startTime: allowed.
		currentStart = "123456"
		s.signalOne(linuxProcEntry{pid: 603, ppid: 100, state: 'S', startTime: "123456"}, syscall.SIGKILL)
		if len(killed) != 1 || killed[0] != 603 {
			t.Fatalf("expected only direct matching child 603 killed, got %v", killed)
		}
	})
}
