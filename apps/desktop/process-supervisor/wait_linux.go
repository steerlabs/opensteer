//go:build linux

package main

import (
	"errors"
	"os"
	"strconv"
	"strings"
	"syscall"

	"golang.org/x/sys/unix"
)

func waitWithoutReaping(processID int) error {
	var information unix.Siginfo
	return unix.Waitid(
		unix.P_PID,
		processID,
		&information,
		unix.WEXITED|unix.WNOWAIT,
		nil,
	)
}

// Whether the process has already ended, without reaping it or waiting for it: a stop sent to a
// target that is already a zombie did not end it. Nor did one sent to a target a SIGKILL already
// reached: waitid reports a process of several threads only once the last of them is gone, and
// until then its leader reads as a zombie while the others are still dying, with that SIGKILL
// pending for the whole thread group (ShdPnd in its status), where it stays until the group is gone.
func endedWithoutReaping(processID int) bool {
	var information unix.Siginfo
	err := unix.Waitid(unix.P_PID, processID, &information, unix.WEXITED|unix.WNOWAIT|unix.WNOHANG, nil)
	// With WNOHANG and nothing to report, waitid succeeds and leaves the zeroed siginfo as it was.
	if err == nil && information.Signo != 0 {
		return true
	}
	raw, readErr := os.ReadFile("/proc/" + strconv.Itoa(processID) + "/status")
	if readErr != nil {
		return false
	}
	pending, ok := parseLinuxSharedPending(string(raw))
	return ok && pending&(1<<(uint(unix.SIGKILL)-1)) != 0
}

// The signals pending for a whole thread group, from its /proc status (ShdPnd, a hexadecimal mask
// whose bit N-1 is signal N).
func parseLinuxSharedPending(status string) (uint64, bool) {
	for _, line := range strings.Split(status, "\n") {
		if value, found := strings.CutPrefix(line, "ShdPnd:"); found {
			pending, err := strconv.ParseUint(strings.TrimSpace(value), 16, 64)
			return pending, err == nil
		}
	}
	return 0, false
}

func enableChildSubreaper() error {
	return unix.Prctl(unix.PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0)
}

type linuxProcEntry struct {
	pid       int
	ppid      int
	state     byte
	startTime string
}

func parseLinuxProcStat(text string) (ppid int, state byte, startTime string, ok bool) {
	closeIndex := strings.LastIndexByte(text, ')')
	if closeIndex < 0 || closeIndex+2 >= len(text) {
		return 0, 0, "", false
	}
	fields := strings.Fields(text[closeIndex+2:])
	if len(fields) < 20 || len(fields[0]) == 0 {
		return 0, 0, "", false
	}
	parsedPpid, ppidErr := strconv.Atoi(fields[1])
	if ppidErr != nil || fields[19] == "" {
		return 0, 0, "", false
	}
	return parsedPpid, fields[0][0], fields[19], true
}

func readLinuxProcStartTime(pid int) (string, error) {
	raw, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat")
	if err != nil {
		return "", err
	}
	_, _, startTime, ok := parseLinuxProcStat(string(raw))
	if !ok {
		return "", errors.New("malformed /proc stat")
	}
	return startTime, nil
}

func readLinuxSubreaperDescendants() ([]linuxProcEntry, error) {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return nil, err
	}
	self := os.Getpid()
	children := make(map[int][]linuxProcEntry)
	for _, entry := range entries {
		pid, convErr := strconv.Atoi(entry.Name())
		if convErr != nil || pid <= 0 || pid == self {
			continue
		}
		raw, readErr := os.ReadFile("/proc/" + entry.Name() + "/stat")
		if readErr != nil {
			continue
		}
		ppid, state, startTime, ok := parseLinuxProcStat(string(raw))
		if !ok {
			continue
		}
		children[ppid] = append(children[ppid], linuxProcEntry{
			pid:       pid,
			ppid:      ppid,
			state:     state,
			startTime: startTime,
		})
	}
	var result []linuxProcEntry
	queue := append([]linuxProcEntry(nil), children[self]...)
	seen := make(map[int]bool, len(queue))
	for len(queue) > 0 {
		current := queue[0]
		queue = queue[1:]
		if seen[current.pid] {
			continue
		}
		seen[current.pid] = true
		result = append(result, current)
		queue = append(queue, children[current.pid]...)
	}
	return result, nil
}

type linuxDescendantSignaler struct {
	selfPID         int
	openPidfd       func(pid int, flags int) (int, error)
	closeFd         func(fd int) error
	readStartTime   func(pid int) (string, error)
	sendPidfdSignal func(fd int, sig unix.Signal, info *unix.Siginfo, flags int) error
	killPID         func(pid int, sig syscall.Signal) error
}

func defaultLinuxDescendantSignaler() linuxDescendantSignaler {
	return linuxDescendantSignaler{
		selfPID:         os.Getpid(),
		openPidfd:       unix.PidfdOpen,
		closeFd:         unix.Close,
		readStartTime:   readLinuxProcStartTime,
		sendPidfdSignal: unix.PidfdSendSignal,
		killPID:         syscall.Kill,
	}
}

// signalOne pins proc's kernel struct pid with pidfd_open, verifies the
// process's start time in /proc/<pid>/stat still matches what was discovered,
// and delivers sig atomically via pidfd_send_signal so PID reuse can never
// redirect a signal to an unrelated process.
func (s linuxDescendantSignaler) signalOne(proc linuxProcEntry, sig syscall.Signal) {
	if proc.pid <= 0 || proc.startTime == "" {
		return
	}
	fd, err := s.openPidfd(proc.pid, 0)
	if err == nil {
		defer func() { _ = s.closeFd(fd) }()
		currentStart, readErr := s.readStartTime(proc.pid)
		if readErr != nil || currentStart != proc.startTime {
			return
		}
		_ = s.sendPidfdSignal(fd, unix.Signal(sig), nil, 0)
		return
	}
	// On pre-5.3 kernels without pidfd_open (ENOSYS), only signal direct
	// unreaped children (whose PID the kernel holds until we reap them) after
	// confirming their start time still matches.
	if errors.Is(err, unix.ENOSYS) && proc.ppid == s.selfPID {
		currentStart, readErr := s.readStartTime(proc.pid)
		if readErr != nil || currentStart != proc.startTime {
			return
		}
		_ = s.killPID(proc.pid, sig)
	}
}

func signalSubreaperDescendants(rootPID int, sig syscall.Signal) error {
	descendants, err := readLinuxSubreaperDescendants()
	if err != nil {
		return err
	}
	self := os.Getpid()
	signaler := defaultLinuxDescendantSignaler()
	for _, proc := range descendants {
		if proc.pid == rootPID {
			continue
		}
		if proc.ppid == self && proc.state == 'Z' {
			var status unix.WaitStatus
			_, _ = unix.Wait4(proc.pid, &status, unix.WNOHANG, nil)
			continue
		}
		signaler.signalOne(proc, sig)
	}
	return nil
}

func subreaperDescendantsEmpty(rootPID int) (bool, error) {
	descendants, err := readLinuxSubreaperDescendants()
	if err != nil {
		return false, err
	}
	self := os.Getpid()
	remaining := 0
	for _, proc := range descendants {
		if proc.pid == rootPID {
			continue
		}
		if proc.ppid == self && proc.state == 'Z' {
			var status unix.WaitStatus
			if reaped, waitErr := unix.Wait4(proc.pid, &status, unix.WNOHANG, nil); waitErr == nil && reaped == proc.pid {
				continue
			}
		}
		remaining++
	}
	return remaining == 0, nil
}

// reapAdoptedChildren reaps exited descendants re-parented to this subreaper
// while the supervised root process is still running, never reaping rootPID.
func reapAdoptedChildren(rootPID int) {
	tasks, err := os.ReadDir("/proc/self/task")
	if err != nil {
		return
	}
	for _, task := range tasks {
		raw, readErr := os.ReadFile("/proc/self/task/" + task.Name() + "/children")
		if readErr != nil {
			continue
		}
		for _, field := range strings.Fields(string(raw)) {
			pid, convErr := strconv.Atoi(field)
			if convErr != nil || pid <= 0 || pid == rootPID {
				continue
			}
			var status unix.WaitStatus
			_, _ = unix.Wait4(pid, &status, unix.WNOHANG, nil)
		}
	}
}
