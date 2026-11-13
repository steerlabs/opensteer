//go:build darwin || linux

package main

import (
	"errors"
	"os"
	"os/exec"
	"syscall"
)

const undrainedExitCode = 70

type posixProcessContainment struct {
	processGroupID int
}

func newProcessContainment() (processContainment, error) {
	return &posixProcessContainment{}, nil
}

func targetCommand(target launch) *exec.Cmd {
	return exec.Command(target.executable, target.arguments...)
}

func (containment *posixProcessContainment) prepare(command *exec.Cmd) error {
	if command.SysProcAttr == nil {
		command.SysProcAttr = &syscall.SysProcAttr{}
	}
	command.SysProcAttr.Setpgid = true
	return nil
}

func (containment *posixProcessContainment) started(command *exec.Cmd) error {
	if command.Process == nil || command.Process.Pid < 1 {
		return errors.New("target process has no process group leader")
	}
	containment.processGroupID = command.Process.Pid
	return nil
}

func (containment *posixProcessContainment) wait(command *exec.Cmd) <-chan targetExit {
	exited := make(chan targetExit, 1)
	go func() {
		exited <- targetExit{observationError: waitWithoutReaping(command.Process.Pid), reap: true}
	}()
	return exited
}

func (containment *posixProcessContainment) graceful() error {
	return containment.signal(syscall.SIGTERM)
}

func (containment *posixProcessContainment) force() error {
	return containment.signal(syscall.SIGKILL)
}

func (containment *posixProcessContainment) empty() (bool, error) {
	if containment.processGroupID < 1 {
		return true, nil
	}
	err := syscall.Kill(-containment.processGroupID, 0)
	if err == nil || errors.Is(err, syscall.EPERM) {
		return false, nil
	}
	if errors.Is(err, syscall.ESRCH) {
		return true, nil
	}
	return false, err
}

func (containment *posixProcessContainment) signal(signal syscall.Signal) error {
	if containment.processGroupID < 1 {
		return syscall.ESRCH
	}
	return syscall.Kill(-containment.processGroupID, signal)
}

func terminationSignals() []os.Signal {
	return []os.Signal{os.Interrupt, syscall.SIGTERM, syscall.SIGHUP}
}

func processAlreadyGone(err error) bool {
	// Darwin reports EPERM when a group contains only its unreaped zombie
	// leader. Verification after reaping still fails closed if an actually
	// unsignalable descendant remains.
	return errors.Is(err, syscall.ESRCH) || errors.Is(err, syscall.EPERM)
}
