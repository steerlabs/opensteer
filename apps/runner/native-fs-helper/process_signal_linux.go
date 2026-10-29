//go:build linux

package main

import (
	"fmt"
	"os/exec"
	"syscall"

	"golang.org/x/sys/unix"
)

func runtimePidfdSignalProbe() error {
	child := exec.Command("/bin/sleep", "30")
	if err := child.Start(); err != nil {
		return fmt.Errorf("start pidfd signal probe child: %w", err)
	}
	pidfd, err := unix.PidfdOpen(child.Process.Pid, 0)
	if err != nil {
		_ = child.Process.Kill()
		_ = child.Wait()
		return fmt.Errorf("open pidfd for signal probe child: %w", err)
	}
	defer unix.Close(pidfd)
	if err := unix.PidfdSendSignal(pidfd, unix.SIGTERM, nil, 0); err != nil {
		_ = child.Process.Kill()
		_ = child.Wait()
		return fmt.Errorf("signal pidfd probe child: %w", err)
	}
	if err := child.Wait(); err == nil {
		return fmt.Errorf("pidfd signal probe child exited without a signal")
	} else if exit, ok := err.(*exec.ExitError); !ok {
		return fmt.Errorf("wait for pidfd signal probe child: %w", err)
	} else if status, ok := exit.ProcessState.Sys().(syscall.WaitStatus); !ok || !status.Signaled() || status.Signal() != syscall.SIGTERM {
		return fmt.Errorf("pidfd signal probe child did not terminate from SIGTERM: %w", err)
	}
	return nil
}
