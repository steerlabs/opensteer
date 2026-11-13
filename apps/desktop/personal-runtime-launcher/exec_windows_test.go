package main

import (
	"bufio"
	"errors"
	"fmt"
	"os"
	osexec "os/exec"
	"os/signal"
	"strings"
	"syscall"
	"testing"
	"time"
)

var (
	kernel32                          = syscall.NewLazyDLL("kernel32.dll")
	procedureGenerateConsoleCtrlEvent = kernel32.NewProc("GenerateConsoleCtrlEvent")
)

const (
	helperModeEnvironment = "OPENSTEER_PERSONAL_RUNTIME_LAUNCHER_TEST_MODE"
	interpreterExitCode   = 23
)

func TestMain(testingMain *testing.M) {
	switch os.Getenv(helperModeEnvironment) {
	case "launcher":
		environment := append(os.Environ(), helperModeEnvironment+"=interpreter")
		if err := exec(os.Args[0], []string{os.Args[0]}, environment); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(70)
		}
		os.Exit(0)
	case "interpreter":
		events := make(chan os.Signal, 1)
		signal.Notify(events, os.Interrupt)
		fmt.Println("ready")
		<-events
		fmt.Println("acknowledged")
		// Stands in for a service's asynchronous shutdown work.
		time.Sleep(500 * time.Millisecond)
		fmt.Println("cleaned")
		os.Exit(interpreterExitCode)
	default:
		os.Exit(testingMain.Run())
	}
}

func TestLauncherOutlivesItsInterpreterCtrlBreakCleanup(t *testing.T) {
	attachConsole(t)
	launcher := osexec.Command(os.Args[0])
	launcher.Env = append(os.Environ(), helperModeEnvironment+"=launcher")
	launcher.SysProcAttr = &syscall.SysProcAttr{CreationFlags: syscall.CREATE_NEW_PROCESS_GROUP}
	launcher.Stderr = os.Stderr
	output, err := launcher.StdoutPipe()
	if err != nil {
		t.Fatalf("create launcher output pipe: %v", err)
	}
	if err := launcher.Start(); err != nil {
		t.Fatalf("start launcher: %v", err)
	}
	t.Cleanup(func() { _ = launcher.Process.Kill() })
	lines := make(chan string, 4)
	go func() {
		defer close(lines)
		scanner := bufio.NewScanner(output)
		for scanner.Scan() {
			lines <- scanner.Text()
		}
	}()
	if line, _ := nextLine(t, lines); line != "ready" {
		t.Fatalf("interpreter wrote %q before the stop event, want ready", line)
	}
	if sent, _, err := procedureGenerateConsoleCtrlEvent.Call(syscall.CTRL_BREAK_EVENT, uintptr(launcher.Process.Pid)); sent == 0 {
		t.Fatalf("send CTRL_BREAK to the launcher group: %v", err)
	}
	var written []string
	for line, open := nextLine(t, lines); open; line, open = nextLine(t, lines) {
		written = append(written, line)
	}
	exited := make(chan error, 1)
	go func() { exited <- launcher.Wait() }()
	select {
	case err := <-exited:
		var exitError *osexec.ExitError
		if !errors.As(err, &exitError) || exitError.ExitCode() != interpreterExitCode {
			t.Fatalf("launcher exited with %v after CTRL_BREAK, want the interpreter's %d", err, interpreterExitCode)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("launcher did not exit within 10s of CTRL_BREAK")
	}
	if strings.Join(written, ",") != "acknowledged,cleaned" {
		t.Fatalf("interpreter wrote %q after CTRL_BREAK, want acknowledged and cleaned", written)
	}
}

func nextLine(t *testing.T, lines <-chan string) (string, bool) {
	t.Helper()
	select {
	case line, open := <-lines:
		return line, open
	case <-time.After(10 * time.Second):
		t.Fatal("launcher wrote no output within 10s")
	}
	return "", false
}

// GenerateConsoleCtrlEvent reaches only processes on the caller's console.
func attachConsole(t *testing.T) {
	t.Helper()
	if window, _, _ := kernel32.NewProc("GetConsoleWindow").Call(); window != 0 {
		return
	}
	if allocated, _, err := kernel32.NewProc("AllocConsole").Call(); allocated == 0 && !errors.Is(err, syscall.ERROR_ACCESS_DENIED) {
		t.Fatalf("allocate a console: %v", err)
	}
}
