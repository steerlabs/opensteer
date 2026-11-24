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
