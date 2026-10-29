//go:build linux

package main

import "golang.org/x/sys/unix"

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
