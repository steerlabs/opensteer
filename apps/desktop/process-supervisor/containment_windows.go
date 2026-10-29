//go:build windows

package main

import (
	"errors"
	"os"
	"os/exec"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

const forcedExitCode = 137

type windowsProcessContainment struct {
	job            windows.Handle
	processGroupID uint32
}

type jobBasicAccountingInformation struct {
	TotalUserTime             int64
	TotalKernelTime           int64
	ThisPeriodTotalUserTime   int64
	ThisPeriodTotalKernelTime int64
	TotalPageFaultCount       uint32
	TotalProcesses            uint32
	ActiveProcesses           uint32
	TotalTerminatedProcesses  uint32
}

func newProcessContainment() (processContainment, error) {
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return nil, err
	}
	var limits windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION
	limits.BasicLimitInformation.LimitFlags =
		windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE |
			windows.JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION
	if _, err := windows.SetInformationJobObject(
		job,
		windows.JobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&limits)),
		uint32(unsafe.Sizeof(limits)),
	); err != nil {
		windows.CloseHandle(job)
		return nil, err
	}
	if err := windows.AssignProcessToJobObject(job, windows.CurrentProcess()); err != nil {
		windows.CloseHandle(job)
		return nil, err
	}
	if err := prepareHiddenConsole(); err != nil {
		// Closing the only job handle after assignment deliberately terminates
		// this wrapper. No target has been launched at this point.
		windows.CloseHandle(job)
		return nil, err
	}
	return &windowsProcessContainment{job: job}, nil
}

func (containment *windowsProcessContainment) prepare(command *exec.Cmd) error {
	command.SysProcAttr = &syscall.SysProcAttr{
		CreationFlags: windows.CREATE_NEW_PROCESS_GROUP,
		HideWindow:    true,
	}
	return nil
}

func (containment *windowsProcessContainment) started(command *exec.Cmd) error {
	if command.Process == nil || command.Process.Pid < 1 {
		return errors.New("target process has no Windows process-group identity")
	}
	containment.processGroupID = uint32(command.Process.Pid)
	return nil
}

func (containment *windowsProcessContainment) wait(command *exec.Cmd) <-chan targetExit {
	exited := make(chan targetExit, 1)
	go func() { exited <- targetExit{result: command.Wait()} }()
	return exited
}

func (containment *windowsProcessContainment) graceful() error {
	if containment.processGroupID == 0 {
		return windows.ERROR_NOT_FOUND
	}
	return windows.GenerateConsoleCtrlEvent(windows.CTRL_BREAK_EVENT, containment.processGroupID)
}

func (containment *windowsProcessContainment) force() error {
	// The wrapper is intentionally a member of the nested Job. Windows kills
	// it and every descendant as one kernel operation, so this call normally
	// does not return to user space.
	return windows.TerminateJobObject(containment.job, forcedExitCode)
}

func (containment *windowsProcessContainment) empty() (bool, error) {
	var accounting jobBasicAccountingInformation
	if err := windows.QueryInformationJobObject(
		containment.job,
		windows.JobObjectBasicAccountingInformation,
		uintptr(unsafe.Pointer(&accounting)),
		uint32(unsafe.Sizeof(accounting)),
		nil,
	); err != nil {
		return false, err
	}
	// This wrapper remains in the Job until it exits. No other active process
	// means the complete target tree has drained.
	return accounting.ActiveProcesses <= 1, nil
}

func terminationSignals() []os.Signal {
	return []os.Signal{os.Interrupt}
}

func processAlreadyGone(err error) bool {
	return errors.Is(err, windows.ERROR_INVALID_PARAMETER) ||
		errors.Is(err, windows.ERROR_NOT_FOUND)
}

func secureControlChannel(control *os.File) error {
	return windows.SetHandleInformation(
		windows.Handle(control.Fd()),
		windows.HANDLE_FLAG_INHERIT,
		0,
	)
}

var (
	kernel32                   = windows.NewLazySystemDLL("kernel32.dll")
	user32                     = windows.NewLazySystemDLL("user32.dll")
	procedureAllocConsole      = kernel32.NewProc("AllocConsole")
	procedureGetConsoleWindow  = kernel32.NewProc("GetConsoleWindow")
	procedureSetConsoleHandler = kernel32.NewProc("SetConsoleCtrlHandler")
	procedureShowWindow        = user32.NewProc("ShowWindow")
)

func prepareHiddenConsole() error {
	allocated, _, allocationError := procedureAllocConsole.Call()
	if allocated == 0 && !errors.Is(allocationError, windows.ERROR_ACCESS_DENIED) {
		return allocationError
	}
	window, _, _ := procedureGetConsoleWindow.Call()
	if window != 0 {
		const hideWindow = 0
		procedureShowWindow.Call(window, hideWindow)
	}
	// A nil handler makes this wrapper ignore console control events. The
	// target's separately-addressable group still receives CTRL_BREAK.
	installed, _, installError := procedureSetConsoleHandler.Call(0, 1)
	if installed == 0 {
		return installError
	}
	return nil
}
