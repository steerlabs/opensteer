//go:build linux

package main

import (
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

func enableChildSubreaper() error {
	return unix.Prctl(unix.PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0)
}

type linuxProcEntry struct {
	pid   int
	ppid  int
	state byte
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
		text := string(raw)
		closeIndex := strings.LastIndexByte(text, ')')
		if closeIndex < 0 || closeIndex+2 >= len(text) {
			continue
		}
		fields := strings.Fields(text[closeIndex+2:])
		if len(fields) < 2 || len(fields[0]) == 0 {
			continue
		}
		ppid, ppidErr := strconv.Atoi(fields[1])
		if ppidErr != nil {
			continue
		}
		children[ppid] = append(children[ppid], linuxProcEntry{
			pid:   pid,
			ppid:  ppid,
			state: fields[0][0],
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

func signalSubreaperDescendants(rootPID int, sig syscall.Signal) error {
	descendants, err := readLinuxSubreaperDescendants()
	if err != nil {
		return err
	}
	self := os.Getpid()
	for _, proc := range descendants {
		if proc.pid == rootPID {
			continue
		}
		if proc.ppid == self && proc.state == 'Z' {
			var status unix.WaitStatus
			_, _ = unix.Wait4(proc.pid, &status, unix.WNOHANG, nil)
			continue
		}
		_ = syscall.Kill(proc.pid, sig)
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
