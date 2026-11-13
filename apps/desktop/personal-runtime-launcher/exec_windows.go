//go:build windows

package main

import (
	"errors"
	"os"
	osexec "os/exec"
	"os/signal"
	"syscall"
)

// Windows has no process-replacing exec, so the launcher stays the parent of the
// pinned interpreter, forwards the standard streams the supervisor created, and
// reports the interpreter's exit status as its own. The kill-on-close Job Object
// the supervisor installs still owns the whole tree.
func exec(executable string, arguments []string, environment []string) error {
	// The supervisor stops this process group with CTRL_BREAK, which the
	// interpreter receives too. Go would exit at once by default; the supervisor
	// would then see its root gone and terminate the Job mid-cleanup.
	consoleEvents := make(chan os.Signal, 1)
	signal.Notify(consoleEvents, os.Interrupt, syscall.SIGTERM)
	command := osexec.Command(executable, arguments[1:]...)
	command.Env = environment
	command.Stdin = os.Stdin
	command.Stdout = os.Stdout
	command.Stderr = os.Stderr
	err := command.Run()
	if err == nil {
		return nil
	}
	var exit *osexec.ExitError
	if errors.As(err, &exit) {
		os.Exit(exit.ExitCode())
	}
	return err
}
