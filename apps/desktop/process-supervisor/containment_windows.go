//go:build windows

package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

const (
	forcedExitCode = 137
	// Outside 0-255, where every target status is reported: the Job was ended
	// without proof that its other members finished terminating.
	undrainedExitCode = 256
	// Within the owner's own settle budget after it asks for a force stop.
	drainDeadline      = 2 * time.Second
	drainPollInterval  = 10 * time.Millisecond
	listedProcessLimit = 256
)

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

type jobProcessIDList struct {
	assigned uint32
	listed   uint32
	ids      [listedProcessLimit]uintptr
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

func targetCommand(target launch) *exec.Cmd {
	command := exec.Command(target.executable, target.arguments...)
	if target.windowsCommandLine != "" {
		command.SysProcAttr = &syscall.SysProcAttr{CmdLine: target.windowsCommandLine}
	}
	return command
}

func (containment *windowsProcessContainment) prepare(command *exec.Cmd) error {
	if command.SysProcAttr == nil {
		command.SysProcAttr = &syscall.SysProcAttr{}
	}
	command.SysProcAttr.CreationFlags |= windows.CREATE_NEW_PROCESS_GROUP
	command.SysProcAttr.HideWindow = true
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

// force ends every other member of the Job and waits on each one's handle, so
// returning means they have finished terminating, not merely been told to. The
// supervisor stays a member, so its own death still ends whatever is left.
func (containment *windowsProcessContainment) force() error {
	deadline := time.Now().Add(drainDeadline)
	for {
		members, err := containment.otherMembers()
		drained := false
		if err == nil {
			err = containment.endAndWait(members, deadline)
		}
		if err == nil {
			drained, err = containment.empty()
		}
		if err == nil && drained {
			return nil
		}
		if err == nil && time.Now().After(deadline) {
			err = fmt.Errorf("the Job did not drain within %s", drainDeadline)
		}
		if err != nil {
			containment.abandon(err)
		}
		if len(members) == 0 {
			time.Sleep(drainPollInterval)
		}
	}
}

func (containment *windowsProcessContainment) otherMembers() ([]uint32, error) {
	var list jobProcessIDList
	err := windows.QueryInformationJobObject(
		containment.job,
		windows.JobObjectBasicProcessIdList,
		uintptr(unsafe.Pointer(&list)),
		uint32(unsafe.Sizeof(list)),
		nil,
	)
	// A partial list is enough: the drain enumerates again until none remain.
	if err != nil && !(errors.Is(err, windows.ERROR_MORE_DATA) && list.listed > 0) {
		return nil, err
	}
	self := windows.GetCurrentProcessId()
	members := make([]uint32, 0, list.listed)
	for _, id := range list.ids[:min(list.listed, listedProcessLimit)] {
		if uint32(id) != self {
			members = append(members, uint32(id))
		}
	}
	return members, nil
}

func (containment *windowsProcessContainment) endAndWait(members []uint32, deadline time.Time) error {
	var handles []windows.Handle
	defer func() {
		for _, handle := range handles {
			windows.CloseHandle(handle)
		}
	}()
	for _, id := range members {
		handle, err := windows.OpenProcess(
			windows.PROCESS_TERMINATE|windows.SYNCHRONIZE|windows.PROCESS_QUERY_LIMITED_INFORMATION,
			false,
			id,
		)
		if errors.Is(err, windows.ERROR_INVALID_PARAMETER) {
			continue
		}
		if err != nil {
			return fmt.Errorf("open Job member %d: %w", id, err)
		}
		// The id may have been reused since it was listed; only a member is ours.
		var member int32
		if ok, _, err := procedureIsProcessInJob.Call(uintptr(handle), uintptr(containment.job), uintptr(unsafe.Pointer(&member))); ok == 0 {
			windows.CloseHandle(handle)
			return fmt.Errorf("check Job member %d: %w", id, err)
		}
		if member == 0 {
			windows.CloseHandle(handle)
			continue
		}
		handles = append(handles, handle)
		// A member already exiting refuses termination; waiting on it still proves it gone.
		_ = windows.TerminateProcess(handle, forcedExitCode)
	}
	for _, handle := range handles {
		milliseconds := max(time.Until(deadline).Milliseconds(), 0)
		if event, err := windows.WaitForSingleObject(handle, uint32(milliseconds)); event != windows.WAIT_OBJECT_0 {
			return fmt.Errorf("a Job member did not finish terminating: %v", err)
		}
	}
	return nil
}

// abandon ends the Job, this supervisor included, with the status that tells
// the owner its targets are not proven gone.
func (containment *windowsProcessContainment) abandon(cause error) {
	fmt.Fprintf(os.Stderr, "opensteer-process-supervisor: containment drain failed: %v\n", cause)
	_ = windows.TerminateJobObject(containment.job, undrainedExitCode)
	os.Exit(undrainedExitCode)
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
	return accounting.ActiveProcesses == 1, nil
}

func terminationSignals() []os.Signal {
	return []os.Signal{os.Interrupt}
}

func processAlreadyGone(err error) bool {
	return errors.Is(err, windows.ERROR_INVALID_PARAMETER) ||
		errors.Is(err, windows.ERROR_NOT_FOUND)
}

var (
	kernel32                   = windows.NewLazySystemDLL("kernel32.dll")
	user32                     = windows.NewLazySystemDLL("user32.dll")
	procedureAllocConsole      = kernel32.NewProc("AllocConsole")
	procedureIsProcessInJob    = kernel32.NewProc("IsProcessInJob")
	procedureGetConsoleWindow  = kernel32.NewProc("GetConsoleWindow")
	procedureSetConsoleHandler = kernel32.NewProc("SetConsoleCtrlHandler")
	procedureShowWindow        = user32.NewProc("ShowWindow")
)

func prepareHiddenConsole() error {
	allocated, _, allocationError := procedureAllocConsole.Call()
	if allocated == 0 && !errors.Is(allocationError, windows.ERROR_ACCESS_DENIED) {
		return allocationError
	}
	// Only a console this wrapper allocated is hidden; an inherited one is the person's terminal.
	if window, _, _ := procedureGetConsoleWindow.Call(); allocated != 0 && window != 0 {
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
