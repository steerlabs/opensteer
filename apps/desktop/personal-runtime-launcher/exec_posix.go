//go:build !windows

package main

import "syscall"

// exec replaces the launcher with the pinned interpreter so the process
// supervisor keeps the same process identity, process group, and standard
// streams it created for this Personal runtime component.
func exec(executable string, arguments []string, environment []string) error {
	return syscall.Exec(executable, arguments, environment)
}
