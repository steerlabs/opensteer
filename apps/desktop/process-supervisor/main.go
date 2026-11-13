package main

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

const (
	controlFileDescriptor = 3
	pollInterval          = 25 * time.Millisecond
)

type controlCommand uint8

const (
	commandGraceful controlCommand = iota + 1
	commandForce
	commandControlClosed
	commandInvalid
)

type processContainment interface {
	prepare(*exec.Cmd) error
	started(*exec.Cmd) error
	wait(*exec.Cmd) <-chan targetExit
	graceful() error
	force() error
	empty() (bool, error)
}

type targetExit struct {
	observationError error
	result           error
	reap             bool
}

func main() {
	os.Exit(run(os.Args[1:], os.Stdin, os.Stdout, os.Stderr))
}

func run(arguments []string, stdin io.Reader, stdout io.Writer, stderr io.Writer) int {
	target, err := parseLaunch(arguments, runtime.GOOS == "windows")
	if err != nil {
		fmt.Fprintf(stderr, "opensteer-process-supervisor: %v\n", err)
		return 64
	}
	control, err := openControlChannel()
	if err != nil {
		fmt.Fprintf(stderr, "opensteer-process-supervisor: control channel is unavailable: %v\n", err)
		return 70
	}
	defer control.Close()

	containment, err := newProcessContainment()
	if err != nil {
		fmt.Fprintf(stderr, "opensteer-process-supervisor: containment setup failed: %v\n", err)
		return 70
	}
	command := targetCommand(target)
	command.Stdin = stdin
	command.Stdout = stdout
	command.Stderr = stderr
	command.Env = os.Environ()
	if err := containment.prepare(command); err != nil {
		fmt.Fprintf(stderr, "opensteer-process-supervisor: target preparation failed: %v\n", err)
		return 70
	}
	if err := command.Start(); err != nil {
		fmt.Fprintf(stderr, "opensteer-process-supervisor: target start failed: %v\n", err)
		return 71
	}
	if err := containment.started(command); err != nil {
		_ = command.Process.Kill()
		_, _ = command.Process.Wait()
		fmt.Fprintf(stderr, "opensteer-process-supervisor: containment activation failed: %v\n", err)
		return 70
	}

	commands := readControlCommands(control)
	targetExited := containment.wait(command)
	operatingSystemSignals := make(chan os.Signal, 2)
	signal.Notify(operatingSystemSignals, terminationSignals()...)
	defer signal.Stop(operatingSystemSignals)
	ticker := time.NewTicker(pollInterval)
	defer ticker.Stop()

	var targetResult error
	rootExited := false
	forced := false
	externalSignals := 0
	for {
		select {
		case exit := <-targetExited:
			// POSIX observes exit without reaping the group leader. That zombie is
			// an unambiguous PGID anchor while residual descendants are killed; no
			// mutating group operation occurs after it is reaped, so PID reuse can
			// never redirect a signal to an unrelated process group.
			if exit.observationError != nil {
				fmt.Fprintf(stderr, "opensteer-process-supervisor: target exit observation failed: %v\n", exit.observationError)
			}
			if exit.reap {
				if !forced {
					forced = true
					if err := containment.force(); err != nil && !processAlreadyGone(err) {
						fmt.Fprintf(stderr, "opensteer-process-supervisor: descendant cleanup failed: %v\n", err)
					}
				}
				targetResult = command.Wait()
			} else {
				targetResult = exit.result
			}
			if targetResult != nil {
				fmt.Fprintf(stderr, "opensteer-process-supervisor: target stopped: %v\n", targetResult)
			}
			rootExited = true
			isEmpty, emptyError := containment.empty()
			if emptyError != nil {
				fmt.Fprintf(stderr, "opensteer-process-supervisor: containment query failed: %v\n", emptyError)
			}
			if !isEmpty && !forced {
				forced = true
				if err := containment.force(); err != nil {
					fmt.Fprintf(stderr, "opensteer-process-supervisor: descendant cleanup failed: %v\n", err)
				}
			}
		case requested, open := <-commands:
			if !open {
				commands = nil
				continue
			}
			if rootExited {
				continue
			}
			switch requested {
			case commandGraceful:
				if err := containment.graceful(); err != nil && !processAlreadyGone(err) {
					fmt.Fprintf(stderr, "opensteer-process-supervisor: graceful stop failed: %v\n", err)
				}
			case commandForce, commandControlClosed:
				if !forced {
					forced = true
					if err := containment.force(); err != nil && !processAlreadyGone(err) {
						fmt.Fprintf(stderr, "opensteer-process-supervisor: forced stop failed: %v\n", err)
					}
				}
			case commandInvalid:
				fmt.Fprintln(stderr, "opensteer-process-supervisor: invalid control command")
				if !forced {
					forced = true
					_ = containment.force()
				}
			}
		case <-operatingSystemSignals:
			externalSignals++
			if externalSignals == 1 && !forced {
				if err := containment.graceful(); err != nil && !processAlreadyGone(err) {
					fmt.Fprintf(stderr, "opensteer-process-supervisor: graceful signal failed: %v\n", err)
				}
			} else if !forced {
				forced = true
				_ = containment.force()
			}
		case <-ticker.C:
		}

		if rootExited {
			isEmpty, emptyError := containment.empty()
			if emptyError != nil {
				fmt.Fprintf(stderr, "opensteer-process-supervisor: containment verification failed: %v\n", emptyError)
				return undrainedExitCode
			}
			if isEmpty {
				return targetExitCode(targetResult)
			}
		}
	}
}

type launch struct {
	executable         string
	arguments          []string
	windowsCommandLine string
}

func parseLaunch(arguments []string, onWindows bool) (launch, error) {
	var parsed launch
	if len(arguments) > 0 && arguments[0] == "--windows-command-line" {
		if !onWindows {
			return launch{}, errors.New("--windows-command-line is only supported on Windows")
		}
		if len(arguments) < 2 || strings.TrimSpace(arguments[1]) == "" {
			return launch{}, errors.New("--windows-command-line requires a command line")
		}
		if strings.ContainsRune(arguments[1], 0) {
			return launch{}, errors.New("--windows-command-line must not contain NUL")
		}
		parsed.windowsCommandLine = arguments[1]
		arguments = arguments[2:]
	}
	if len(arguments) < 2 || arguments[0] != "--" || strings.TrimSpace(arguments[1]) == "" {
		return launch{}, errors.New("expected -- followed by an executable")
	}
	if !filepath.IsAbs(arguments[1]) {
		return launch{}, errors.New("target executable must be absolute")
	}
	if parsed.windowsCommandLine != "" && len(arguments) > 2 {
		return launch{}, errors.New("--windows-command-line takes no arguments after the executable")
	}
	parsed.executable = arguments[1]
	parsed.arguments = arguments[2:]
	return parsed, nil
}

func readControlCommands(reader io.Reader) <-chan controlCommand {
	commands := make(chan controlCommand, 1)
	go func() {
		defer close(commands)
		scanner := bufio.NewScanner(reader)
		scanner.Buffer(make([]byte, 64), 1024)
		for scanner.Scan() {
			switch scanner.Text() {
			case "graceful":
				commands <- commandGraceful
			case "force":
				commands <- commandForce
			default:
				commands <- commandInvalid
				return
			}
		}
		if scanner.Err() != nil {
			commands <- commandInvalid
			return
		}
		commands <- commandControlClosed
	}()
	return commands
}

func targetExitCode(result error) int {
	if result == nil {
		return 0
	}
	var exitError *exec.ExitError
	if errors.As(result, &exitError) {
		code := exitError.ExitCode()
		if code >= 0 && code <= 255 {
			return code
		}
	}
	return 1
}
