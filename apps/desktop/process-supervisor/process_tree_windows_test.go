package main

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

const (
	helperModeEnvironment = "OPENSTEER_PROCESS_SUPERVISOR_TEST_MODE"
	targetModeEnvironment = "OPENSTEER_PROCESS_SUPERVISOR_TEST_TARGET_MODE"
	wrapperMarker         = "--opensteer-wrapper"
	exitDeadline          = 10 * time.Second
	rootExitCode          = 3
)

var procedureGetHandleInformation = kernel32.NewProc("GetHandleInformation")

func TestMain(testingMain *testing.M) {
	switch os.Getenv(helperModeEnvironment) {
	case "wrapper":
		for index, argument := range os.Args {
			if argument == wrapperMarker {
				os.Setenv(helperModeEnvironment, os.Getenv(targetModeEnvironment))
				os.Exit(run(os.Args[index+1:], os.Stdin, os.Stdout, os.Stderr))
			}
		}
		os.Exit(64)
	case "control-probe":
		control, err := openControlChannel()
		if err != nil {
			fmt.Printf("error: %v\n", err)
			os.Exit(70)
		}
		var flags uint32
		if ok, _, err := procedureGetHandleInformation.Call(control.Fd(), uintptr(unsafe.Pointer(&flags))); ok == 0 {
			fmt.Printf("error: %v\n", err)
			os.Exit(70)
		}
		fmt.Printf("inherit=%d\n", flags&windows.HANDLE_FLAG_INHERIT)
		os.Exit(0)
	case "root":
		runWindowsTreeRoot("descendant", false)
	case "root-graceful":
		runWindowsTreeRoot("descendant-graceful", true)
	case "root-protected":
		runWindowsTreeRoot("descendant-protected", false)
	case "descendant":
		runWindowsTreeDescendant(false)
	case "descendant-graceful":
		runWindowsTreeDescendant(true)
	case "descendant-protected":
		if err := denyAllAccessToThisProcess(); err != nil {
			fmt.Fprintf(os.Stderr, "protect descendant: %v\n", err)
			os.Exit(72)
		}
		runWindowsTreeDescendant(false)
	case "print-arguments":
		encoded, _ := json.Marshal(os.Args[1:])
		fmt.Printf("%s\n", encoded)
		os.Exit(0)
	default:
		os.Exit(testingMain.Run())
	}
}

func TestStartupInformationMatchesTheWindowsLayout(t *testing.T) {
	var ours startupInformation
	var theirs windows.StartupInfo
	if unsafe.Sizeof(ours) != unsafe.Sizeof(theirs) ||
		unsafe.Offsetof(ours.showWindow) != unsafe.Offsetof(theirs.ShowWindow) ||
		unsafe.Offsetof(ours.stdInput) != unsafe.Offsetof(theirs.StdInput) ||
		unsafe.Offsetof(ours.stdError) != unsafe.Offsetof(theirs.StdErr) {
		t.Fatalf("STARTUPINFOW layout differs: size %d vs %d", unsafe.Sizeof(ours), unsafe.Sizeof(theirs))
	}
}

func TestWindowsControlChannelIsReadFromTheCrtBlockAndNotInherited(t *testing.T) {
	process := launchWithControlPipe(t, "control-probe", "")
	if line := process.nextLine(t); line != "inherit=0" {
		t.Fatalf("control probe reported %q; stderr %q", line, process.stderr.String())
	}
	if code := process.wait(t); code != 0 {
		t.Fatalf("control probe exited %d", code)
	}
}

func TestWindowsSupervisorFailsClosedWithoutTheControlBlock(t *testing.T) {
	executable := testExecutable(t)
	command := exec.Command(executable, wrapperMarker, "--", executable)
	command.Env = replaceEnvironment(os.Environ(), helperModeEnvironment, "wrapper")
	var stderr bytes.Buffer
	command.Stderr = &stderr
	err := command.Run()
	exitError, ok := err.(*exec.ExitError)
	if !ok || uint32(exitError.ExitCode()) != drainedStatus(t, 70) || !strings.Contains(stderr.String(), "control channel is unavailable") {
		t.Fatalf("supervisor without a control block returned %v, stderr %q; want drained exit 70", err, stderr.String())
	}
}

func TestWindowsSupervisorFailsClosedOnANonPipeControlHandle(t *testing.T) {
	file, err := os.Create(filepath.Join(t.TempDir(), "not-a-pipe"))
	if err != nil {
		t.Fatalf("create control file: %v", err)
	}
	defer file.Close()
	process := launchWithControl(t, "wrapper", "root", windows.Handle(file.Fd()), "--", testExecutable(t))
	if code := process.wait(t); code != drainedStatus(t, 70) {
		t.Fatalf("supervisor exited %#x with a file as control; want drained 70", code)
	}
	process.waitForOutputEnd(t)
	if !strings.Contains(process.stderr.String(), "not a pipe") {
		t.Fatalf("stderr %q does not name the rejected control handle", process.stderr.String())
	}
}

func TestWindowsGracefulStopReachesTheWholeTargetGroup(t *testing.T) {
	process := launchWithControlPipe(t, "wrapper", "root-graceful", "--", testExecutable(t))
	tree := process.readTree(t)
	process.writeControl(t, "graceful\n")
	if code := process.wait(t); code != drainedStatus(t, 0) {
		t.Fatalf("supervisor exited %#x after a graceful tree exit; want drained 0; stderr %q", code, process.stderr.String())
	}
	tree.requireAlreadyGone(t)
}

func TestWindowsForceStopsTheCompleteTree(t *testing.T) {
	process := launchWithControlPipe(t, "wrapper", "root", "--", testExecutable(t))
	tree := process.readTree(t)
	process.writeControl(t, "graceful\n")
	process.writeControl(t, "force\n")
	if code := process.wait(t); code != drainedStatus(t, forcedExitCode) {
		t.Fatalf("supervisor exited %#x after force; want drained %d", code, forcedExitCode)
	}
	tree.requireAlreadyGone(t)
}

func TestWindowsControlEndOfFileStopsTheCompleteTree(t *testing.T) {
	process := launchWithControlPipe(t, "wrapper", "root", "--", testExecutable(t))
	tree := process.readTree(t)
	if err := process.control.Close(); err != nil {
		t.Fatalf("close control channel: %v", err)
	}
	if code := process.wait(t); code != drainedStatus(t, forcedExitCode) {
		t.Fatalf("supervisor exited %#x after owner death; want drained %d", code, forcedExitCode)
	}
	tree.requireAlreadyGone(t)
}

func TestWindowsRootExitStopsResidualDescendants(t *testing.T) {
	process := launchWithControlPipe(t, "wrapper", "root", "--", testExecutable(t))
	tree := process.readTree(t)
	if _, err := io.WriteString(process.stdin, "exit\n"); err != nil {
		t.Fatalf("ask the root to exit: %v", err)
	}
	if code := process.wait(t); code != drainedStatus(t, rootExitCode) {
		t.Fatalf("supervisor exited %#x after its root exited %d; stderr %q", code, rootExitCode, process.stderr.String())
	}
	tree.requireAlreadyGone(t)
}

func TestWindowsAnUnprovenDrainNeverReportsTheDrainedTag(t *testing.T) {
	process := launchWithControlPipe(t, "wrapper", "root-protected", "--", testExecutable(t))
	process.nextLine(t)
	process.writeControl(t, "force\n")
	if code := process.wait(t); code != undrainedExitCode {
		t.Fatalf("supervisor exited %#x after a member refused to be opened; want %d; stderr %q", code, undrainedExitCode, process.stderr.String())
	}
	process.waitForOutputEnd(t)
	if !strings.Contains(process.stderr.String(), "containment drain failed") {
		t.Fatalf("stderr %q does not say the drain failed", process.stderr.String())
	}
}

func TestWindowsCommandLineReachesTheTargetVerbatim(t *testing.T) {
	directory := filepath.Join(t.TempDir(), "dir with space & amp")
	if err := os.Mkdir(directory, 0o700); err != nil {
		t.Fatalf("create target directory: %v", err)
	}
	target := filepath.Join(directory, "target.exe")
	copyFile(t, testExecutable(t), target)
	system, err := windows.GetSystemDirectory()
	if err != nil {
		t.Fatalf("locate System32: %v", err)
	}
	line := `cmd.exe /d /s /v:off /c ""` + target + `" "a b" "x&y" "c^d" "bang!" "q\"z" "tail\\""`
	process := launchWithControlPipe(t, "wrapper", "print-arguments",
		"--windows-command-line", line, "--", filepath.Join(system, "cmd.exe"))
	output := process.nextLine(t)
	if code := process.wait(t); code != drainedStatus(t, 0) {
		t.Fatalf("supervisor exited %#x; stderr %q", code, process.stderr.String())
	}
	var arguments []string
	if err := json.Unmarshal([]byte(output), &arguments); err != nil {
		t.Fatalf("decode target arguments %q: %v", output, err)
	}
	want := []string{"a b", "x&y", "c^d", "bang!", `q"z`, `tail\`}
	if !reflect.DeepEqual(arguments, want) {
		t.Fatalf("target received %q, want %q", arguments, want)
	}
}

type windowsTree struct {
	Root       uint32 `json:"root"`
	Descendant uint32 `json:"descendant"`
	handles    []windows.Handle
}

// requireAlreadyGone checks without waiting: the supervisor's exit must itself
// mean every process of its tree has finished terminating.
func (tree windowsTree) requireAlreadyGone(t *testing.T) {
	t.Helper()
	for _, handle := range tree.handles {
		if event, err := windows.WaitForSingleObject(handle, 0); event != windows.WAIT_OBJECT_0 {
			t.Fatalf("tree process %#v was still terminating when the supervisor exited (%v)", tree, err)
		}
	}
}

// drainedStatus is the exit code that proves the Job drained with the target
// status `status`, checked to carry that status back out unchanged.
func drainedStatus(t *testing.T, status int) uint32 {
	t.Helper()
	code := uint32(drainedExitCode(status))
	if code&^0xFF != drainedExitTag || int(code&0xFF) != status {
		t.Fatalf("drained exit code %#x does not carry target status %d", code, status)
	}
	return code
}

// denyAllAccessToThisProcess gives this process an empty DACL, so the
// supervisor, which holds no debug privilege, cannot open it to end it.
func denyAllAccessToThisProcess() error {
	descriptor, err := windows.SecurityDescriptorFromString("D:P")
	if err != nil {
		return err
	}
	dacl, _, err := descriptor.DACL()
	if err != nil {
		return err
	}
	return windows.SetSecurityInfo(
		windows.CurrentProcess(),
		windows.SE_KERNEL_OBJECT,
		windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION,
		nil,
		nil,
		dacl,
		nil,
	)
}

func runWindowsTreeRoot(descendantMode string, graceful bool) {
	signals := make(chan os.Signal, 4)
	signal.Notify(signals, os.Interrupt)
	descendant := exec.Command(os.Args[0])
	descendant.Env = replaceEnvironment(os.Environ(), helperModeEnvironment, descendantMode)
	descendant.Stderr = os.Stderr
	ready, err := descendant.StdoutPipe()
	if err == nil {
		err = descendant.Start()
	}
	if err != nil {
		fmt.Fprintf(os.Stderr, "start descendant: %v\n", err)
		os.Exit(72)
	}
	if _, err := io.ReadFull(ready, make([]byte, 1)); err != nil {
		fmt.Fprintf(os.Stderr, "wait for descendant readiness: %v\n", err)
		os.Exit(72)
	}
	encoded, _ := json.Marshal(windowsTree{Root: uint32(os.Getpid()), Descendant: uint32(descendant.Process.Pid)})
	fmt.Printf("%s\n", encoded)
	if graceful {
		<-signals
		_ = descendant.Wait()
		os.Exit(0)
	}
	_, _ = bufio.NewReader(os.Stdin).ReadString('\n')
	os.Exit(rootExitCode)
}

func runWindowsTreeDescendant(graceful bool) {
	signals := make(chan os.Signal, 4)
	signal.Notify(signals, os.Interrupt)
	_, _ = os.Stdout.Write([]byte{1})
	<-signals
	if graceful {
		os.Exit(0)
	}
	for range signals {
	}
}

type launchedProcess struct {
	process windows.Handle
	stdin   *os.File
	control *os.File
	lines   chan string
	stderr  *lockedBuffer
	done    sync.WaitGroup
}

func launchWithControlPipe(t *testing.T, mode string, targetMode string, arguments ...string) *launchedProcess {
	t.Helper()
	reader, writer := pipe(t)
	process := launchWithControl(t, mode, targetMode, windows.Handle(reader.Fd()), arguments...)
	reader.Close()
	process.control = writer
	return process
}

// launchWithControl starts this test binary the way libuv spawns a child with
// a fourth "pipe" stdio entry: bInheritHandles and a CRT handle block whose
// entry 3 is the control handle.
func launchWithControl(t *testing.T, mode string, targetMode string, control windows.Handle, arguments ...string) *launchedProcess {
	t.Helper()
	executable := testExecutable(t)
	stdinReader, stdinWriter := pipe(t)
	stdoutReader, stdoutWriter := pipe(t)
	stderrReader, stderrWriter := pipe(t)
	childHandles := []windows.Handle{
		windows.Handle(stdinReader.Fd()),
		windows.Handle(stdoutWriter.Fd()),
		windows.Handle(stderrWriter.Fd()),
		control,
	}
	for _, handle := range childHandles {
		if err := windows.SetHandleInformation(handle, windows.HANDLE_FLAG_INHERIT, windows.HANDLE_FLAG_INHERIT); err != nil {
			t.Fatalf("make child handle inheritable: %v", err)
		}
	}
	pointerSize := int(unsafe.Sizeof(uintptr(0)))
	block := binary.LittleEndian.AppendUint32(nil, 4)
	block = append(block, 0, 0, 0, crtFlagOpen|crtFlagPipe)
	for index := range 4 {
		value := uint64(^uintptr(0))
		if index == 3 {
			value = uint64(control)
		}
		if pointerSize == 8 {
			block = binary.LittleEndian.AppendUint64(block, value)
		} else {
			block = binary.LittleEndian.AppendUint32(block, uint32(value))
		}
	}
	information := startupInformation{
		flags:         windows.STARTF_USESTDHANDLES,
		reserved2Size: uint16(len(block)),
		reserved2:     &block[0],
		stdInput:      childHandles[0],
		stdOutput:     childHandles[1],
		stdError:      childHandles[2],
	}
	information.size = uint32(unsafe.Sizeof(information))
	environment := replaceEnvironment(os.Environ(), helperModeEnvironment, mode)
	environment = replaceEnvironment(environment, targetModeEnvironment, targetMode)
	commandLine, err := windows.UTF16PtrFromString(windows.ComposeCommandLine(append([]string{executable, wrapperMarker}, arguments...)))
	if err != nil {
		t.Fatalf("encode command line: %v", err)
	}
	application, _ := windows.UTF16PtrFromString(executable)
	var processInformation windows.ProcessInformation
	err = windows.CreateProcess(
		application,
		commandLine,
		nil,
		nil,
		true,
		windows.CREATE_UNICODE_ENVIRONMENT,
		environmentBlock(environment),
		nil,
		(*windows.StartupInfo)(unsafe.Pointer(&information)),
		&processInformation,
	)
	runtime.KeepAlive(block)
	for _, file := range []*os.File{stdinReader, stdoutWriter, stderrWriter} {
		file.Close()
	}
	if err != nil {
		t.Fatalf("start supervisor: %v", err)
	}
	windows.CloseHandle(processInformation.Thread)
	launched := &launchedProcess{
		process: processInformation.Process,
		stdin:   stdinWriter,
		lines:   make(chan string, 16),
		stderr:  &lockedBuffer{},
	}
	t.Cleanup(func() {
		// Ending the supervisor closes its kill-on-close Job, which ends the tree.
		_ = windows.TerminateProcess(launched.process, 1)
		windows.CloseHandle(launched.process)
		stdinWriter.Close()
		if launched.control != nil {
			launched.control.Close()
		}
	})
	launched.done.Add(2)
	go func() {
		defer launched.done.Done()
		defer close(launched.lines)
		scanner := bufio.NewScanner(stdoutReader)
		for scanner.Scan() {
			launched.lines <- scanner.Text()
		}
		stdoutReader.Close()
	}()
	go func() {
		defer launched.done.Done()
		_, _ = io.Copy(launched.stderr, stderrReader)
		stderrReader.Close()
	}()
	return launched
}

func (process *launchedProcess) nextLine(t *testing.T) string {
	t.Helper()
	select {
	case line, open := <-process.lines:
		if !open {
			t.Fatalf("process output ended early; stderr %q", process.stderr.String())
		}
		return line
	case <-time.After(exitDeadline):
		t.Fatalf("process wrote no line within %s; stderr %q", exitDeadline, process.stderr.String())
	}
	return ""
}

func (process *launchedProcess) readTree(t *testing.T) windowsTree {
	t.Helper()
	line := process.nextLine(t)
	var tree windowsTree
	if err := json.Unmarshal([]byte(line), &tree); err != nil || tree.Root == 0 || tree.Descendant == 0 {
		t.Fatalf("decode target tree %q: %v", line, err)
	}
	for _, id := range []uint32{tree.Root, tree.Descendant} {
		handle, err := windows.OpenProcess(windows.SYNCHRONIZE, false, id)
		if err != nil {
			t.Fatalf("open tree process %d: %v", id, err)
		}
		t.Cleanup(func() { windows.CloseHandle(handle) })
		tree.handles = append(tree.handles, handle)
	}
	return tree
}

func (process *launchedProcess) writeControl(t *testing.T, command string) {
	t.Helper()
	if _, err := io.WriteString(process.control, command); err != nil {
		t.Fatalf("write control command %q: %v", command, err)
	}
}

func (process *launchedProcess) wait(t *testing.T) uint32 {
	t.Helper()
	if event, err := windows.WaitForSingleObject(process.process, uint32(exitDeadline/time.Millisecond)); event != windows.WAIT_OBJECT_0 {
		t.Fatalf("supervisor did not exit within %s (%v); stderr %q", exitDeadline, err, process.stderr.String())
	}
	var code uint32
	if err := windows.GetExitCodeProcess(process.process, &code); err != nil {
		t.Fatalf("read supervisor exit code: %v", err)
	}
	return code
}

func (process *launchedProcess) waitForOutputEnd(t *testing.T) {
	t.Helper()
	finished := make(chan struct{})
	go func() { process.done.Wait(); close(finished) }()
	select {
	case <-finished:
	case <-time.After(exitDeadline):
		t.Fatalf("process output did not end within %s", exitDeadline)
	}
}

type lockedBuffer struct {
	mutex  sync.Mutex
	buffer bytes.Buffer
}

func (buffer *lockedBuffer) Write(data []byte) (int, error) {
	buffer.mutex.Lock()
	defer buffer.mutex.Unlock()
	return buffer.buffer.Write(data)
}

func (buffer *lockedBuffer) String() string {
	buffer.mutex.Lock()
	defer buffer.mutex.Unlock()
	return buffer.buffer.String()
}

// pipe returns non-inheritable ends; syscall.Pipe makes both inheritable,
// which would leak the parent's ends into a bInheritHandles child.
func pipe(t *testing.T) (*os.File, *os.File) {
	t.Helper()
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatalf("create pipe: %v", err)
	}
	for _, file := range []*os.File{reader, writer} {
		if err := windows.SetHandleInformation(windows.Handle(file.Fd()), windows.HANDLE_FLAG_INHERIT, 0); err != nil {
			t.Fatalf("make pipe end non-inheritable: %v", err)
		}
	}
	return reader, writer
}

func environmentBlock(entries []string) *uint16 {
	var block []uint16
	for _, entry := range entries {
		encoded, _ := windows.UTF16FromString(entry)
		block = append(block, encoded...)
	}
	block = append(block, 0)
	return &block[0]
}

func replaceEnvironment(environment []string, name string, value string) []string {
	prefix := strings.ToUpper(name) + "="
	result := make([]string, 0, len(environment)+1)
	for _, entry := range environment {
		if !strings.HasPrefix(strings.ToUpper(entry), prefix) {
			result = append(result, entry)
		}
	}
	return append(result, name+"="+value)
}

func testExecutable(t *testing.T) string {
	t.Helper()
	executable, err := os.Executable()
	if err != nil {
		t.Fatalf("locate test executable: %v", err)
	}
	return executable
}

func copyFile(t *testing.T, source string, destination string) {
	t.Helper()
	data, err := os.ReadFile(source)
	if err != nil {
		t.Fatalf("read %s: %v", source, err)
	}
	if err := os.WriteFile(destination, data, 0o700); err != nil {
		t.Fatalf("write %s: %v", destination, err)
	}
}
