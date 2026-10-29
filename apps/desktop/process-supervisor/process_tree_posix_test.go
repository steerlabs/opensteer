//go:build darwin || linux

package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

const helperModeEnvironment = "OPENSTEER_PROCESS_SUPERVISOR_TEST_MODE"

func TestMain(testingMain *testing.M) {
	switch os.Getenv(helperModeEnvironment) {
	case "wrapper":
		separator := -1
		for index, argument := range os.Args {
			if argument == "--opensteer-wrapper-target" {
				separator = index
				break
			}
		}
		if separator < 0 {
			os.Exit(64)
		}
		os.Exit(run(append([]string{"--"}, os.Args[separator+1:]...), os.Stdin, os.Stdout, os.Stderr))
	case "root":
		runTreeRoot(false, false)
		os.Exit(0)
	case "root-exits":
		runTreeRoot(true, false)
		os.Exit(0)
	case "root-exits-on-graceful":
		runTreeRoot(false, true)
		os.Exit(0)
	case "descendant":
		runTreeDescendant()
		os.Exit(0)
	default:
		os.Exit(testingMain.Run())
	}
}

func TestForceStopsRootAndDescendantTree(t *testing.T) {
	wrapper, control, output := startWrapperTree(t, "root")
	identities := readTreeIdentities(t, output)

	if _, err := io.WriteString(control, "graceful\n"); err != nil {
		t.Fatalf("write graceful command: %v", err)
	}
	time.Sleep(100 * time.Millisecond)
	if !processExists(identities.Root) || !processExists(identities.Descendant) {
		t.Fatal("a process that ignored graceful termination exited before force")
	}
	if _, err := io.WriteString(control, "force\n"); err != nil {
		t.Fatalf("write force command: %v", err)
	}
	if err := waitWithDeadline(wrapper, 3*time.Second); err == nil {
		// A force exit is intentionally non-zero.
	} else if _, ok := err.(*exec.ExitError); !ok {
		t.Fatalf("wrapper did not terminate: %v", err)
	}
	requireProcessGone(t, identities.Root)
	requireProcessGone(t, identities.Descendant)
}

func TestControlCloseStopsTheCompleteTree(t *testing.T) {
	wrapper, control, output := startWrapperTree(t, "root")
	identities := readTreeIdentities(t, output)
	if err := control.Close(); err != nil {
		t.Fatalf("close control channel: %v", err)
	}
	if err := waitWithDeadline(wrapper, 3*time.Second); err == nil {
		// Closing the owner channel force-stops the tree and is non-zero.
	} else if _, ok := err.(*exec.ExitError); !ok {
		t.Fatalf("wrapper did not terminate after control close: %v", err)
	}
	requireProcessGone(t, identities.Root)
	requireProcessGone(t, identities.Descendant)
}

func TestRootExitCleansResidualDescendantBeforeGroupLeaderReap(t *testing.T) {
	wrapper, _, output := startWrapperTree(t, "root-exits")
	identities := readTreeIdentities(t, output)
	if err := waitWithDeadline(wrapper, 3*time.Second); err != nil {
		t.Fatalf("wrapper did not clean up after its target root exited: %v", err)
	}
	requireProcessGone(t, identities.Root)
	requireProcessGone(t, identities.Descendant)
}

func TestControlCloseAtRootExitBoundaryStopsResidualDescendant(t *testing.T) {
	wrapper, control, output := startWrapperTree(t, "root-exits-on-graceful")
	identities := readTreeIdentities(t, output)
	if _, err := io.WriteString(control, "graceful\n"); err != nil {
		t.Fatalf("write graceful command: %v", err)
	}
	// Closing the owner endpoint races the root's graceful exit. Whichever
	// event the wrapper observes first must still force the residual tree while
	// the unreaped process-group leader anchors the PGID.
	if err := control.Close(); err != nil {
		t.Fatalf("close control channel at target-exit boundary: %v", err)
	}
	if err := waitWithDeadline(wrapper, 3*time.Second); err != nil {
		if _, ok := err.(*exec.ExitError); !ok {
			t.Fatalf("wrapper did not terminate at target-exit boundary: %v", err)
		}
	}
	requireProcessGone(t, identities.Root)
	requireProcessGone(t, identities.Descendant)
}

type treeIdentities struct {
	Root       int `json:"root"`
	Descendant int `json:"descendant"`
}

func startWrapperTree(t *testing.T, targetMode string) (*exec.Cmd, *os.File, io.Reader) {
	t.Helper()
	controlReader, controlWriter, err := os.Pipe()
	if err != nil {
		t.Fatalf("create control pipe: %v", err)
	}
	t.Cleanup(func() {
		_ = controlReader.Close()
		_ = controlWriter.Close()
	})
	command := exec.Command(
		os.Args[0],
		"--opensteer-wrapper-target",
		"/usr/bin/env",
		helperModeEnvironment+"="+targetMode,
		os.Args[0],
		"-test.run=^$",
	)
	command.Env = replaceEnvironment(os.Environ(), helperModeEnvironment, "wrapper")
	command.ExtraFiles = []*os.File{controlReader}
	output, err := command.StdoutPipe()
	if err != nil {
		t.Fatalf("create stdout pipe: %v", err)
	}
	command.Stderr = os.Stderr
	if err := command.Start(); err != nil {
		t.Fatalf("start wrapper: %v", err)
	}
	if err := controlReader.Close(); err != nil {
		t.Fatalf("close parent control reader: %v", err)
	}
	return command, controlWriter, output
}

func readTreeIdentities(t *testing.T, output io.Reader) treeIdentities {
	t.Helper()
	line, err := bufio.NewReader(output).ReadString('\n')
	if err != nil {
		t.Fatalf("read target identities: %v", err)
	}
	var identities treeIdentities
	if err := json.Unmarshal([]byte(line), &identities); err != nil {
		t.Fatalf("decode target identities %q: %v", line, err)
	}
	if identities.Root < 1 || identities.Descendant < 1 {
		t.Fatalf("invalid target identities: %#v", identities)
	}
	return identities
}

func runTreeRoot(exitImmediately bool, exitOnGraceful bool) {
	signals := make(chan os.Signal, 4)
	signalNotify(signals)
	readyReader, readyWriter, err := os.Pipe()
	if err != nil {
		fmt.Fprintf(os.Stderr, "create descendant readiness pipe: %v\n", err)
		os.Exit(72)
	}
	descendant := exec.Command(os.Args[0], "-test.run=^$")
	descendant.Env = replaceEnvironment(os.Environ(), helperModeEnvironment, "descendant")
	descendant.ExtraFiles = []*os.File{readyWriter}
	descendant.Stdin = nil
	descendant.Stdout = nil
	descendant.Stderr = os.Stderr
	if err := descendant.Start(); err != nil {
		fmt.Fprintf(os.Stderr, "start descendant: %v\n", err)
		os.Exit(72)
	}
	_ = readyWriter.Close()
	_ = readyReader.SetReadDeadline(time.Now().Add(2 * time.Second))
	ready := make([]byte, 1)
	if _, err := io.ReadFull(readyReader, ready); err != nil || ready[0] != 1 {
		fmt.Fprintf(os.Stderr, "wait for descendant readiness: %v\n", err)
		os.Exit(72)
	}
	_ = readyReader.Close()
	encoded, _ := json.Marshal(treeIdentities{Root: os.Getpid(), Descendant: descendant.Process.Pid})
	fmt.Printf("%s\n", encoded)
	if exitImmediately {
		return
	}
	if exitOnGraceful {
		<-signals
		return
	}
	for range signals {
	}
}

func runTreeDescendant() {
	signals := make(chan os.Signal, 4)
	signalNotify(signals)
	ready := os.NewFile(3, "opensteer-test-descendant-ready")
	if ready == nil {
		os.Exit(72)
	}
	_, _ = ready.Write([]byte{1})
	_ = ready.Close()
	for range signals {
	}
}

func ignoreTerminationForever() {
	signals := make(chan os.Signal, 4)
	signalNotify(signals)
	for range signals {
	}
}

func signalNotify(channel chan<- os.Signal) {
	// Kept in a helper so vet can see the intentionally retained channel.
	signal.Notify(channel, syscall.SIGINT, syscall.SIGTERM, syscall.SIGHUP)
}

func replaceEnvironment(environment []string, name string, value string) []string {
	prefix := name + "="
	result := make([]string, 0, len(environment)+1)
	for _, entry := range environment {
		if !strings.HasPrefix(entry, prefix) {
			result = append(result, entry)
		}
	}
	return append(result, prefix+value)
}

func waitWithDeadline(command *exec.Cmd, timeout time.Duration) error {
	result := make(chan error, 1)
	go func() { result <- command.Wait() }()
	select {
	case err := <-result:
		return err
	case <-time.After(timeout):
		return errors.New("process did not exit before deadline")
	}
}

func requireProcessGone(t *testing.T, processID int) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for processExists(processID) && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if processExists(processID) {
		t.Fatalf("process %s still exists", strconv.Itoa(processID))
	}
}

func processExists(processID int) bool {
	err := syscall.Kill(processID, 0)
	return err == nil || errors.Is(err, syscall.EPERM)
}
