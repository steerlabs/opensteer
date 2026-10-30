//go:build linux || darwin

package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"os/signal"
	"os/user"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"
	"golang.org/x/sys/unix"
)

var shellTestBinary string

func TestMain(testingMain *testing.M) {
	directory, err := os.MkdirTemp("", "opensteer-shell-tests-")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	defer os.RemoveAll(directory)
	shellTestBinary = filepath.Join(directory, "opensteer-native-fs")
	command := exec.Command("go", "build", "-o", shellTestBinary, ".")
	command.Stdout = os.Stdout
	command.Stderr = os.Stderr
	if err := command.Run(); err != nil {
		os.Exit(1)
	}
	os.Exit(testingMain.Run())
}

func TestShellProxyProcess(t *testing.T) {
	if os.Getenv("OPENSTEER_SHELL_TEST_PROXY") != "1" {
		return
	}
	// OpenSSH sends its ProxyCommand SIGHUP the moment the client exits. This
	// process stands in for the target Runner as well as the proxy, so it has to
	// outlive that signal to copy the records shell-serve writes while it winds
	// down; otherwise the last audits of a short session are lost with the pipe.
	signal.Ignore(syscall.SIGHUP)
	initContent, err := base64.RawStdEncoding.DecodeString(os.Getenv("OPENSTEER_SHELL_TEST_INIT"))
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	command := exec.Command(shellTestBinary, "shell-serve")
	command.Env = append(os.Environ(), "SHELL=/bin/sh")
	stdin, err := command.StdinPipe()
	if err != nil {
		os.Exit(1)
	}
	stdout, err := command.StdoutPipe()
	if err != nil {
		os.Exit(1)
	}
	command.Stderr = os.Stderr
	recordReader, recordWriter, err := os.Pipe()
	if err != nil {
		os.Exit(1)
	}
	command.ExtraFiles = []*os.File{recordWriter}
	if err := command.Start(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	_ = recordWriter.Close()
	recordDone := make(chan struct{})
	go func() {
		defer close(recordDone)
		defer recordReader.Close()
		if os.Getenv("OPENSTEER_SHELL_TEST_DRAIN") == "0" {
			<-time.After(2 * time.Second)
			return
		}
		file, openErr := os.OpenFile(os.Getenv("OPENSTEER_SHELL_TEST_RECORDS"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
		if openErr == nil {
			_, _ = io.Copy(file, recordReader)
			_ = file.Close()
		}
	}()
	var length [4]byte
	binary.BigEndian.PutUint32(length[:], uint32(len(initContent)))
	_, _ = stdin.Write(length[:])
	_, _ = stdin.Write(initContent)
	inputDone := make(chan struct{})
	go func() {
		_, _ = io.Copy(stdin, os.Stdin)
		_ = stdin.Close()
		close(inputDone)
	}()
	_, _ = io.Copy(os.Stdout, stdout)
	_ = command.Wait()
	<-recordDone
	if address := os.Getenv("OPENSTEER_SHELL_TEST_DONE"); address != "" {
		connection, err := net.Dial("unix", address)
		if err == nil {
			_ = connection.Close()
		}
	}
	os.Exit(0)
}

func TestShellKeygenIsIdempotent(t *testing.T) {
	directory := t.TempDir()
	first := runTestBinary(t, nil, "shell-keygen", "--out", directory)
	second := runTestBinary(t, nil, "shell-keygen", "--out", directory)
	if first != second || !strings.HasPrefix(first, "ssh-ed25519 ") {
		t.Fatalf("key generation was not idempotent: %q != %q", first, second)
	}
	info, err := os.Stat(filepath.Join(directory, shellHostKeyName))
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatalf("host key mode = %v, error = %v", info.Mode().Perm(), err)
	}
}

func TestSSHProxyRelayProtocol(t *testing.T) {
	socket := filepath.Join(t.TempDir(), "relay.sock")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	serverDone := make(chan error, 1)
	go func() {
		connection, acceptErr := listener.Accept()
		if acceptErr != nil {
			serverDone <- acceptErr
			return
		}
		defer connection.Close()
		reader := bufio.NewReader(connection)
		line, readErr := reader.ReadString('\n')
		if readErr != nil || line != "{\"target\":\"rnr_test\"}\n" {
			serverDone <- fmt.Errorf("request %q: %w", line, readErr)
			return
		}
		_, _ = io.WriteString(connection, "{\"ok\":true}\nremote")
		content, readErr := io.ReadAll(reader)
		if readErr != nil || string(content) != "local" {
			serverDone <- fmt.Errorf("stream %q: %w", content, readErr)
			return
		}
		if unixConnection, ok := connection.(*net.UnixConn); ok {
			_ = unixConnection.CloseWrite()
		}
		serverDone <- nil
	}()
	command := exec.Command(shellTestBinary, "ssh-proxy", "--relay", socket, "rnr_test")
	command.Stdin = strings.NewReader("local")
	var stdout, stderr bytes.Buffer
	command.Stdout = &stdout
	command.Stderr = &stderr
	if err := command.Run(); err != nil {
		t.Fatalf("proxy failed: %v: %s", err, stderr.String())
	}
	if stdout.String() != "remote" || stderr.Len() != 0 {
		t.Fatalf("unexpected proxy output stdout=%q stderr=%q", stdout.String(), stderr.String())
	}
	if err := <-serverDone; err != nil {
		t.Fatal(err)
	}

	failureSocket := filepath.Join(t.TempDir(), "relay.sock")
	failureListener, err := net.Listen("unix", failureSocket)
	if err != nil {
		t.Fatal(err)
	}
	defer failureListener.Close()
	go func() {
		connection, _ := failureListener.Accept()
		if connection != nil {
			reader := bufio.NewReader(connection)
			_, _ = reader.ReadString('\n')
			_, _ = io.WriteString(connection, "{\"ok\":false,\"message\":\"Computer is offline.\"}\n")
			_ = connection.Close()
		}
	}()
	command = exec.Command(shellTestBinary, "ssh-proxy", "--relay", failureSocket, "rnr_test")
	output, err := command.CombinedOutput()
	var exit *exec.ExitError
	if !errors.As(err, &exit) || exit.ExitCode() != 255 || string(output) != "Computer is offline.\n" {
		t.Fatalf("unexpected refusal status=%v output=%q", err, output)
	}
}

func TestSSHProxyUsesStandardBytesReader(t *testing.T) {
	_, testPath, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("locate shell integration test source")
	}
	content, err := os.ReadFile(filepath.Join(filepath.Dir(testPath), "ssh_proxy.go"))
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(content, []byte("func newBytesReader")) || !bytes.Contains(content, []byte("bytes.NewReader")) {
		t.Fatal("ssh proxy must use bytes.NewReader instead of a local reader implementation")
	}
}

func TestOpenSSHExecLifecycleAndPolicy(t *testing.T) {
	requireOpenSSH(t, "ssh")
	fixture := newShellSSHFixture(t, shellPolicy{Reach: "deployment", Commands: true, Shares: []shellSharePolicy{}})
	doneDir, err := os.MkdirTemp("/tmp", "ssh-done-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(doneDir) })
	donePath := filepath.Join(doneDir, "done.sock")
	done, err := net.ListenUnix("unix", &net.UnixAddr{Name: donePath, Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	defer done.Close()
	command := fixture.sshCommand("cat; echo done")
	command.Env = append(command.Env, "OPENSTEER_SHELL_TEST_DONE="+donePath)
	command.Stdin = strings.NewReader("input\n")
	output, err := command.CombinedOutput()
	if err != nil || string(output) != "input\ndone\n" {
		t.Fatalf("exec failed: %v output=%q", err, output)
	}
	if err := done.SetDeadline(time.Now().Add(2 * time.Second)); err != nil {
		t.Fatal(err)
	}
	completed, err := done.Accept()
	if err != nil {
		t.Fatalf("proxy did not finish copying records: %v", err)
	}
	_ = completed.Close()
	records := fixture.records(t)
	for _, kind := range []string{"ready", "exec", "process.started", "process.exited", "channel.closed"} {
		if !recordsContain(records, kind) {
			t.Fatalf("missing %s record: %#v", kind, records)
		}
	}
	exitIndex, closeIndex := -1, -1
	for index, record := range records {
		switch record["kind"] {
		case "process.exited":
			exitIndex = index
		case "channel.closed":
			closeIndex = index
		}
	}
	if exitIndex >= closeIndex {
		t.Fatalf("channel closed before process exit record: %#v", records)
	}
	started := recordWithKind(records, "process.started")
	exited := recordWithKind(records, "process.exited")
	if started["processGroupId"] != exited["processGroupId"] || started["channel"] != exited["channel"] {
		t.Fatalf("process lifecycle did not correlate: %#v %#v", started, exited)
	}

	denied := newShellSSHFixture(t, shellPolicy{Reach: "deployment", Commands: false})
	output, err = denied.sshCommand("true").CombinedOutput()
	var exit *exec.ExitError
	if !errors.As(err, &exit) || exit.ExitCode() != 126 || !strings.Contains(string(output), "does not allow commands from other computers") {
		t.Fatalf("commands=false status=%v output=%q", err, output)
	}
	if recordWithKind(denied.records(t), "denied")["what"] != "exec" {
		t.Fatal("missing denied exec audit")
	}
}

func TestShellRefusalsUseInitMachineNameAndExactSentences(t *testing.T) {
	requireOpenSSH(t, "ssh")
	requireOpenSSH(t, "sftp")
	noAccess := newShellSSHFixture(t, shellPolicy{Reach: "deployment", Shares: []shellSharePolicy{}})
	output, err := noAccess.sshCommand("true").CombinedOutput()
	var exit *exec.ExitError
	if !errors.As(err, &exit) || exit.ExitCode() != 126 || string(output) != "Target Mac does not allow commands from other computers.\n" {
		t.Fatalf("command refusal status=%v output=%q", err, output)
	}

	client, closeClient := noAccess.goSFTPClient(t)
	if _, err := client.RealPath("/outside"); err == nil || !strings.HasSuffix(err.Error(), "Not shared. Target Mac shares no folders.") {
		t.Fatalf("no-share refusal = %v", err)
	}
	if _, err := client.RealPath("~another-user"); err == nil || !strings.HasSuffix(err.Error(), "SFTP ~user paths are not supported.") {
		t.Fatalf("~user refusal = %v", err)
	}
	closeClient()
	sshClient, closeSSH := noAccess.goSSHClient(t)
	if _, err := sshClient.Dial("tcp", "127.0.0.1:1"); err == nil || !strings.Contains(err.Error(), "Target Mac does not allow port forwarding from other computers.") {
		closeSSH()
		t.Fatalf("forwarding refusal = %v", err)
	}
	closeSSH()

	first := t.TempDir()
	second := t.TempDir()
	shared := newShellSSHFixture(t, shellPolicy{Reach: "deployment", Shares: []shellSharePolicy{
		{Path: filepath.ToSlash(second), Mode: "read-write"},
		{Path: filepath.ToSlash(first), Mode: "read"},
	}})
	client, closeClient = shared.goSFTPClient(t)
	defer closeClient()
	shareItems := []string{fmt.Sprintf("%s (read-only)", filepath.ToSlash(first)), fmt.Sprintf("%s (read-write)", filepath.ToSlash(second))}
	sort.Strings(shareItems)
	expectedShares := fmt.Sprintf("Target Mac shares: %s.", strings.Join(shareItems, ", "))
	if _, err := client.RealPath("/outside"); err == nil || !strings.HasSuffix(err.Error(), "Not shared. "+expectedShares) {
		t.Fatalf("share-list refusal = %v", err)
	}
	if err := client.Chmod(filepath.ToSlash(first), 0700); err == nil || !strings.HasSuffix(err.Error(), fmt.Sprintf("Shared folder %s is read-only.", filepath.ToSlash(first))) {
		t.Fatalf("read-only refusal = %v", err)
	}
	account, err := user.Current()
	if err != nil {
		t.Fatal(err)
	}
	if err := client.Chmod(filepath.ToSlash(account.HomeDir), 0700); err == nil || !strings.HasSuffix(err.Error(), "Only shared folders can be changed. "+expectedShares) {
		t.Fatalf("synthetic-ancestor refusal = %v", err)
	}
}

func TestOpenSSHExecAuditPreviewIsBoundedWithoutChangingCommand(t *testing.T) {
	requireOpenSSH(t, "ssh")
	fixture := newShellSSHFixture(t, shellPolicy{Reach: "deployment", Commands: true})
	var command strings.Builder
	command.WriteString(`printf 'executed\n'; # `)
	filler := []string{`"`, `'`, `\`, `界`}
	for index := 0; command.Len() < 4000; index++ {
		value := filler[index%len(filler)]
		if command.Len()+len(value) > 4000 {
			value = `"`
		}
		command.WriteString(value)
	}
	if command.Len() != 4000 {
		t.Fatalf("command length = %d, want 4000", command.Len())
	}

	output, err := fixture.sshCommand(command.String()).CombinedOutput()
	if err != nil || string(output) != "executed\n" {
		t.Fatalf("exec failed: %v output=%q", err, output)
	}
	execRecord := recordWithKind(fixture.records(t), "exec")
	preview, ok := execRecord["command"].(string)
	if !ok || len(preview) >= command.Len() || !strings.HasPrefix(command.String(), preview) {
		t.Fatalf("exec audit preview was not a shortened command prefix: %#v", execRecord)
	}
	if execRecord["commandTruncated"] != true {
		t.Fatalf("exec audit did not flag its shortened preview: %#v", execRecord)
	}
	content, err := json.Marshal(execRecord)
	if err != nil || len(content)+1 > maxShellRecordBytes {
		t.Fatalf("exec audit serialized bytes = %d, error = %v", len(content)+1, err)
	}
}

func TestOpenSSHRefusesCommandOver4096BytesWithExactSentence(t *testing.T) {
	requireOpenSSH(t, "ssh")
	fixture := newShellSSHFixture(t, shellPolicy{Reach: "deployment", Commands: true})
	output, err := fixture.sshCommand(strings.Repeat("x", 4097)).CombinedOutput()
	var exit *exec.ExitError
	if !errors.As(err, &exit) || exit.ExitCode() != 126 || string(output) != "Commands longer than 4096 bytes are refused.\n" {
		t.Fatalf("long-command refusal status=%v output=%q", err, output)
	}
}

func TestMaximumSFTPAuditPathsFitRecordLimit(t *testing.T) {
	path := "/" + strings.Repeat(`"'\界`, 170) + "xxx"
	if len(path) != maxShellPathBytes {
		t.Fatalf("path length = %d, want %d", len(path), maxShellPathBytes)
	}
	for _, record := range []map[string]any{
		{"kind": "sftp.open", "channel": uint32(1), "path": path, "mode": "read"},
		{"kind": "sftp.mutate", "channel": uint32(1), "op": "rename", "path": path, "target": path},
	} {
		content, err := marshalShellRecord(record)
		if err != nil {
			t.Fatalf("maximum-length SFTP audit did not fit: %v", err)
		}
		if len(content) > maxShellRecordBytes {
			t.Fatalf("SFTP audit serialized bytes = %d", len(content))
		}
	}
}

func TestMalformedExecPayloadKeepsDistinctRefusal(t *testing.T) {
	fixture := newShellSSHFixture(t, shellPolicy{Reach: "deployment", Commands: true})
	client, closeClient := fixture.goSSHClient(t)
	defer closeClient()
	channel, requests, err := client.OpenChannel("session", nil)
	if err != nil {
		t.Fatal(err)
	}
	accepted, err := channel.SendRequest("exec", true, []byte{0, 0, 0, 8, 'x'})
	if err != nil || !accepted {
		t.Fatalf("malformed exec accepted=%t error=%v", accepted, err)
	}
	stderr, err := io.ReadAll(channel.Stderr())
	if err != nil || string(stderr) != "Opensteer refused an invalid command.\n" {
		t.Fatalf("malformed exec stderr=%q error=%v", stderr, err)
	}
	for range requests {
	}
}

func TestOpenSSHExitStatusSignalAndTerminalRefusal(t *testing.T) {
	requireOpenSSH(t, "ssh")
	fixture := newShellSSHFixture(t, shellPolicy{Reach: "deployment", Commands: true})
	output, err := fixture.sshCommand("exit 23").CombinedOutput()
	var exit *exec.ExitError
	if !errors.As(err, &exit) || exit.ExitCode() != 23 {
		t.Fatalf("exit status=%v output=%q", err, output)
	}
	command := fixture.sshCommand("kill -TERM $$")
	output, err = command.CombinedOutput()
	if !errors.As(err, &exit) {
		t.Fatalf("signal status=%v output=%q", err, output)
	}
	// Audit records travel through the emitter's buffered writer, so the client
	// can see the exit before the record lands: wait for it rather than read once.
	fixture.waitForRecord(t, "channel.closed signal", func(record map[string]any) bool {
		return record["kind"] == "channel.closed" && record["exitSignal"] == "TERM"
	})

	terminal := exec.Command("ssh", "-F", fixture.config, "-tt", "test")
	terminal.Env = fixture.environment()
	output, err = terminal.CombinedOutput()
	if !errors.As(err, &exit) || !strings.Contains(string(output), "PTY allocation request failed") {
		t.Fatalf("terminal refusal status=%v output=%q", err, output)
	}
	fixture.waitForRecord(t, "denied pty", func(record map[string]any) bool {
		return record["kind"] == "denied" && record["what"] == "pty"
	})
}

func TestOpenSSHSFTPReadWriteAndSyntheticNamespace(t *testing.T) {
	requireOpenSSH(t, "sftp")
	requireOpenSSH(t, "scp")
	shared := t.TempDir()
	remoteName := "space-雪-%.txt"
	remotePath := filepath.Join(shared, remoteName)
	if err := os.WriteFile(remotePath, []byte("shared content"), 0600); err != nil {
		t.Fatal(err)
	}
	fixture := newShellSSHFixture(t, shellPolicy{Reach: "deployment", Shares: []shellSharePolicy{{Path: filepath.ToSlash(shared), Mode: "read-write"}}})
	download := filepath.Join(t.TempDir(), "download.txt")
	batch := fmt.Sprintf("pwd\nls /\nls %q\nget %q %q\nrename %q %q\n", filepath.ToSlash(filepath.Dir(shared)), filepath.ToSlash(remotePath), filepath.ToSlash(download), filepath.ToSlash(remotePath), filepath.ToSlash(filepath.Join(shared, "renamed.txt")))
	output, err := fixture.sftpBatch(batch).CombinedOutput()
	if err != nil {
		t.Fatalf("sftp failed: %v\n%s", err, output)
	}
	content, err := os.ReadFile(download)
	if err != nil || string(content) != "shared content" {
		t.Fatalf("download = %q, %v", content, err)
	}
	if _, err := os.Stat(filepath.Join(shared, "renamed.txt")); err != nil {
		t.Fatal(err)
	}
	upload := filepath.Join(t.TempDir(), "upload-雪-%.txt")
	if err := os.WriteFile(upload, []byte("scp upload"), 0600); err != nil {
		t.Fatal(err)
	}
	scp := exec.Command("scp", "-p", "-F", fixture.config, upload, "test:"+filepath.ToSlash(filepath.Join(shared, "scp space-雪-%.txt")))
	scp.Env = fixture.environment()
	if output, err := scp.CombinedOutput(); err != nil {
		t.Fatalf("scp upload failed: %v\n%s", err, output)
	}
	if content, err := os.ReadFile(filepath.Join(shared, "scp space-雪-%.txt")); err != nil || string(content) != "scp upload" {
		t.Fatalf("scp content=%q error=%v", content, err)
	}
	records := fixture.records(t)
	if !recordsContain(records, "sftp.open") || !recordsContain(records, "sftp.mutate") {
		t.Fatalf("missing SFTP audits: %#v", records)
	}
}

// The filesystem root is synthetic like every other ancestor: it names the top
// component of each share and of home, and nothing else the real root holds.
func TestOpenSSHSFTPRootListsOnlyShareBranches(t *testing.T) {
	requireOpenSSH(t, "sftp")
	shared := t.TempDir()
	fixture := newShellSSHFixture(t, shellPolicy{Reach: "deployment", Shares: []shellSharePolicy{{Path: filepath.ToSlash(shared), Mode: "read"}}})
	output, err := fixture.sftpBatch("ls -1 /\n").CombinedOutput()
	if err != nil {
		t.Fatalf("sftp failed: %v\n%s", err, output)
	}
	account, err := user.Current()
	if err != nil {
		t.Fatal(err)
	}
	expected := map[string]struct{}{
		"/" + strings.SplitN(strings.TrimPrefix(shared, "/"), "/", 2)[0]:          {},
		"/" + strings.SplitN(strings.TrimPrefix(account.HomeDir, "/"), "/", 2)[0]: {},
	}
	listed := map[string]struct{}{}
	for _, line := range strings.Split(string(output), "\n") {
		entry := strings.TrimSpace(line)
		if entry == "" || strings.HasPrefix(entry, "sftp>") {
			continue
		}
		listed[entry] = struct{}{}
	}
	if len(listed) != len(expected) {
		t.Fatalf("root listing = %v, want %v\n%s", listed, expected, output)
	}
	for name := range expected {
		if _, ok := listed[name]; !ok {
			t.Fatalf("root listing = %v, want %v\n%s", listed, expected, output)
		}
	}
}

func TestOpenSSHSFTPShareBoundaryRules(t *testing.T) {
	requireOpenSSH(t, "sftp")
	first := t.TempDir()
	second := t.TempDir()
	prefixSibling := first + "2"
	if err := os.Mkdir(prefixSibling, 0700); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(prefixSibling) })
	if err := os.WriteFile(filepath.Join(first, "file.txt"), []byte("inside"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(prefixSibling, "outside.txt"), []byte("outside"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("file.txt", filepath.Join(first, "relative-link")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("/etc/passwd", filepath.Join(first, "absolute-link")); err != nil {
		t.Fatal(err)
	}
	if err := unix.Mkfifo(filepath.Join(first, "pipe"), 0600); err != nil {
		t.Fatal(err)
	}
	fixture := newShellSSHFixture(t, shellPolicy{Reach: "deployment", Shares: []shellSharePolicy{
		{Path: filepath.ToSlash(first), Mode: "read-write"},
		{Path: filepath.ToSlash(second), Mode: "read-write"},
		{Path: filepath.ToSlash(filepath.Join(t.TempDir(), "missing")), Mode: "read"},
	}})
	account, err := user.Current()
	if err != nil {
		t.Fatal(err)
	}
	relative, err := filepath.Rel(account.HomeDir, filepath.Join(first, "file.txt"))
	if err != nil {
		t.Fatal(err)
	}
	download := filepath.Join(t.TempDir(), "relative.txt")
	batch := fmt.Sprintf("get %q %q\nget %q %q\n", filepath.ToSlash(relative), filepath.ToSlash(download), filepath.ToSlash(filepath.Join(first, "relative-link")), filepath.ToSlash(download+"-link"))
	output, err := fixture.sftpBatch(batch).CombinedOutput()
	if err != nil {
		t.Fatalf("relative SFTP failed: %v\n%s", err, output)
	}
	assertSFTPFailure(t, fixture, fmt.Sprintf("get %q %q\n", filepath.ToSlash(filepath.Join(prefixSibling, "outside.txt")), filepath.ToSlash(download)), "Not shared")
	assertSFTPFailure(t, fixture, fmt.Sprintf("get %q %q\n", filepath.ToSlash(filepath.Join(first, "absolute-link")), filepath.ToSlash(download)), "Permission denied")
	assertSFTPFailure(t, fixture, fmt.Sprintf("get %q %q\n", filepath.ToSlash(filepath.Join(first, "pipe")), filepath.ToSlash(download)), "regular file")
	assertSFTPFailure(t, fixture, fmt.Sprintf("rename %q %q\n", filepath.ToSlash(filepath.Join(first, "file.txt")), filepath.ToSlash(filepath.Join(second, "moved.txt"))), "one writable share")
	assertSFTPFailure(t, fixture, fmt.Sprintf("rmdir %q\n", filepath.ToSlash(first)), "root cannot be removed")
	assertSFTPFailure(t, fixture, fmt.Sprintf("ln -s %q %q\n", filepath.ToSlash(filepath.Join(first, "file.txt")), filepath.ToSlash(filepath.Join(first, "new-link"))), "not allowed")

	missing := fixtureMissingShare(fixture)
	assertSFTPFailure(t, fixture, fmt.Sprintf("ls %q\n", missing), "not found")

	readOnly := newShellSSHFixture(t, shellPolicy{Reach: "deployment", Shares: []shellSharePolicy{{Path: filepath.ToSlash(first), Mode: "read"}}})
	upload := filepath.Join(t.TempDir(), "upload.txt")
	if err := os.WriteFile(upload, []byte("upload"), 0600); err != nil {
		t.Fatal(err)
	}
	assertSFTPFailure(t, readOnly, fmt.Sprintf("put %q %q\n", filepath.ToSlash(upload), filepath.ToSlash(filepath.Join(first, "write.txt"))), "read-only")

	ancestor := filepath.ToSlash(filepath.Dir(first))
	output, err = fixture.sftpBatch(fmt.Sprintf("ls %q\n", ancestor)).CombinedOutput()
	if err != nil || !strings.Contains(string(output), filepath.Base(first)) || strings.Contains(string(output), filepath.Base(prefixSibling)) {
		t.Fatalf("synthetic ancestor leaked or omitted branches: %v\n%s", err, output)
	}

	symlinkTarget := t.TempDir()
	if err := os.WriteFile(filepath.Join(symlinkTarget, "root-link.txt"), []byte("linked root"), 0600); err != nil {
		t.Fatal(err)
	}
	symlinkRoot := filepath.Join(t.TempDir(), "shared-link")
	if err := os.Symlink(symlinkTarget, symlinkRoot); err != nil {
		t.Fatal(err)
	}
	symlinkFixture := newShellSSHFixture(t, shellPolicy{Reach: "deployment", Shares: []shellSharePolicy{{Path: filepath.ToSlash(symlinkRoot), Mode: "read"}}})
	symlinkDownload := filepath.Join(t.TempDir(), "root-link.txt")
	output, err = symlinkFixture.sftpBatch(fmt.Sprintf("get %q %q\n", filepath.ToSlash(filepath.Join(symlinkRoot, "root-link.txt")), filepath.ToSlash(symlinkDownload))).CombinedOutput()
	if err != nil {
		t.Fatalf("symlinked share root failed: %v\n%s", err, output)
	}
}

func TestShellSFTPRefusesSpecialFilesAndDirectorySizeWithoutBlocking(t *testing.T) {
	shared := t.TempDir()
	fifo := filepath.Join(shared, "pipe")
	directory := filepath.Join(shared, "directory")
	directoryLink := filepath.Join(shared, "directory-link")
	if err := unix.Mkfifo(fifo, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(directory, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, "entry.txt"), []byte("entry"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("directory", directoryLink); err != nil {
		t.Fatal(err)
	}
	fixture := newShellSSHFixture(t, shellPolicy{Reach: "deployment", Shares: []shellSharePolicy{{Path: filepath.ToSlash(shared), Mode: "read-write"}}})
	client, closeClient := fixture.goSFTPClient(t)
	defer closeClient()

	opendirDone := make(chan error, 1)
	go func() {
		_, err := client.ReadDir(filepath.ToSlash(fifo))
		opendirDone <- err
	}()
	select {
	case err := <-opendirDone:
		if err == nil {
			t.Fatal("OPENDIR accepted a FIFO")
		}
	case <-time.After(2 * time.Second):
		unblockFD, _ := unix.Open(fifo, unix.O_WRONLY|unix.O_NONBLOCK, 0)
		if unblockFD >= 0 {
			_ = unix.Close(unblockFD)
		}
		t.Fatal("OPENDIR blocked on a FIFO")
	}
	entries, err := client.ReadDir(filepath.ToSlash(directoryLink))
	if err != nil || len(entries) != 1 || entries[0] != "entry.txt" {
		t.Fatalf("OPENDIR did not preserve in-share symlink handling: entries=%v error=%v", entries, err)
	}

	if err := client.Truncate(filepath.ToSlash(directory), 0); err == nil {
		t.Fatal("SETSTAT accepted a size change on a directory")
	}
	before, err := os.Lstat(fifo)
	if err != nil {
		t.Fatal(err)
	}
	if err := client.Chmod(filepath.ToSlash(fifo), 0644); err == nil {
		t.Fatal("SETSTAT accepted metadata changes on a FIFO")
	}
	after, err := os.Lstat(fifo)
	if err != nil {
		t.Fatal(err)
	}
	if after.Mode().Perm() != before.Mode().Perm() {
		t.Fatalf("SETSTAT changed FIFO mode from %v to %v", before.Mode().Perm(), after.Mode().Perm())
	}
}

func TestShellSyntheticRootEnumeratesOnlyTopLevelShareBranches(t *testing.T) {
	server := &shellSFTPServer{session: &shellSession{
		home: "/Users/person",
		shares: []*shellShare{
			{path: "/Users/person/Projects"},
			{path: "/srv/shared"},
		},
	}}
	entries := server.syntheticEntries("/")
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		names = append(names, entry.Name())
	}
	if got, want := strings.Join(names, ","), "Users,srv"; got != want {
		t.Fatalf("synthetic root entries = %q, want %q", got, want)
	}
}

func TestShellPathsUseUTF8ByteLimitAndRejectNUL(t *testing.T) {
	validInit := shellInit{
		Authority: shellAuthority{
			CallerMachineName: "caller", PolicyRevision: 1, RequestedBy: "usr_test", RunID: "run_test",
			SessionID: "shell_test", StartedAt: time.Now().UTC().Format(time.RFC3339Nano), ThreadID: "thr_test",
			ThreadTitle: "Shell helper test", WorkspaceID: "ws_test",
		},
		HostKeyPath: "/tmp/shell-key",
		MachineName: "Target Mac",
		Policy:      shellPolicy{Reach: "deployment", Shares: []shellSharePolicy{}},
	}

	validInit.Policy.Shares = []shellSharePolicy{{Path: "/" + strings.Repeat("雪", 341), Mode: "read"}}
	if len(validInit.Policy.Shares[0].Path) != maxShellPathBytes {
		t.Fatal("test share path does not reach the byte boundary")
	}
	if err := validateShellInit(validInit); err != nil {
		t.Fatalf("1024-byte UTF-8 share path was rejected: %v", err)
	}
	validInit.Policy.Shares[0].Path += "a"
	if err := validateShellInit(validInit); err == nil {
		t.Fatal("share path over 1024 UTF-8 bytes was accepted")
	}
	validInit.Policy.Shares = []shellSharePolicy{{Path: "/shared\x00escape", Mode: "read"}}
	if err := validateShellInit(validInit); err == nil {
		t.Fatal("NUL in a share path was accepted")
	}
	validInit.Policy.Shares = []shellSharePolicy{}
	validInit.HostKeyPath = "/tmp/key\x00escape"
	if err := validateShellInit(validInit); err == nil {
		t.Fatal("NUL in the host-key path was accepted")
	}
	if _, err := normalizeShellNamespace("/shared\x00escape", "/Users/person"); err == nil {
		t.Fatal("NUL in an SFTP request path was accepted")
	}
}

func TestShellInitRequiresMachineNameWithinRuneLimit(t *testing.T) {
	valid := shellInit{
		Authority: shellAuthority{
			CallerMachineName: "caller", PolicyRevision: 1, RequestedBy: "usr_test", RunID: "run_test",
			SessionID: "shell_test", StartedAt: time.Now().UTC().Format(time.RFC3339Nano), ThreadID: "thr_test",
			WorkspaceID: "ws_test",
		},
		HostKeyPath: "/tmp/shell-key",
		MachineName: strings.Repeat("雪", 160),
		Policy:      shellPolicy{Reach: "deployment", Shares: []shellSharePolicy{}},
	}
	if err := validateShellInit(valid); err != nil {
		t.Fatalf("160-rune machine name was rejected: %v", err)
	}
	valid.MachineName += "雪"
	if err := validateShellInit(valid); err == nil {
		t.Fatal("161-rune machine name was accepted")
	}
	valid.MachineName = ""
	if err := validateShellInit(valid); err == nil {
		t.Fatal("empty machine name was accepted")
	}
	content, err := json.Marshal(valid)
	if err != nil {
		t.Fatal(err)
	}
	var object map[string]json.RawMessage
	if err := json.Unmarshal(content, &object); err != nil {
		t.Fatal(err)
	}
	delete(object, "machineName")
	content, err = json.Marshal(object)
	if err != nil {
		t.Fatal(err)
	}
	if shellInitHasRequiredFields(content) {
		t.Fatal("init JSON without machineName passed required-field validation")
	}
}

func TestShellTildeComponentUnderHomeResolvesToHome(t *testing.T) {
	home := "/Users/test"
	if got, err := normalizeShellNamespace("~/project", home); err != nil || got != "/Users/test/project" {
		t.Fatalf("leading tilde resolved to %q, %v", got, err)
	}
	// OpenSSH's sftp joins its remote directory onto "~/x" before sending, so
	// this is how a real client's "~/project" arrives.
	if got, err := normalizeShellNamespace("/Users/test/~/project", home); err != nil || got != "/Users/test/project" {
		t.Fatalf("pwd-joined tilde resolved to %q, %v", got, err)
	}
	if got, err := normalizeShellNamespace("/Users/test/~", home); err != nil || got != "/Users/test" {
		t.Fatalf("pwd-joined bare tilde resolved to %q, %v", got, err)
	}
	if got, err := normalizeShellNamespace("/Users/test/~x/project", home); err != nil || got != "/Users/test/~x/project" {
		t.Fatalf("a sibling that merely starts with ~ resolved to %q, %v", got, err)
	}
}

func TestOpenSSHSFTPIncludesNestedMounts(t *testing.T) {
	requireOpenSSH(t, "sftp")
	sharePath := "/proc"
	nestedPath := "/proc/sys"
	if runtime.GOOS == "darwin" {
		sharePath = "/System/Volumes"
		nestedPath = "/System/Volumes/Data"
	}
	if _, err := os.Stat(nestedPath); err != nil {
		t.Fatalf("expected platform mount %s is unavailable: %v", nestedPath, err)
	}
	fixture := newShellSSHFixture(t, shellPolicy{Reach: "deployment", Shares: []shellSharePolicy{{Path: sharePath, Mode: "read"}}})
	if output, err := fixture.sftpBatch(fmt.Sprintf("ls %q\n", nestedPath)).CombinedOutput(); err != nil {
		t.Fatalf("nested mount was excluded: %v\n%s", err, output)
	}
}

func TestShellSFTPShareOpenPermissionIsNotMissing(t *testing.T) {
	requireOpenSSH(t, "sftp")
	requireOpenSSH(t, "ssh")
	if os.Geteuid() == 0 {
		t.Fatal("permission test requires an unprivileged test account")
	}
	parent := t.TempDir()
	shared := filepath.Join(parent, "shared")
	if err := os.Mkdir(shared, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(parent, 0000); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(parent, 0700) })
	fixture := newShellSSHFixture(t, shellPolicy{Reach: "deployment", Commands: true, Shares: []shellSharePolicy{{Path: filepath.ToSlash(shared), Mode: "read"}}})
	if output, err := fixture.sshCommand("true").CombinedOutput(); err != nil {
		t.Fatalf("command was affected by failed share open: %v\n%s", err, output)
	}
	records := fixture.records(t)
	startDenials := 0
	for _, record := range records {
		if record["kind"] == "denied" && record["what"] == "sftp" && strings.Contains(fmt.Sprint(record["detail"]), filepath.ToSlash(shared)) {
			startDenials++
		}
	}
	if startDenials != 1 {
		t.Fatalf("share-open permission failure produced %d startup denials: %#v", startDenials, records)
	}
	output, err := fixture.sftpBatch(fmt.Sprintf("ls %q\n", filepath.ToSlash(shared))).CombinedOutput()
	if err == nil || strings.Contains(string(output), "No such file") {
		t.Fatalf("permission failure collapsed into missing: %v\n%s", err, output)
	}
	denied := false
	for _, record := range fixture.records(t) {
		if record["kind"] == "denied" && record["what"] == "sftp" {
			denied = true
		}
	}
	if !denied {
		t.Fatal("permission failure did not produce denial audit")
	}
}

func TestShellSFTPStatusCodesAreInlined(t *testing.T) {
	if sftpStatusNoSuchFile != 2 || sftpStatusPermissionDenied != 3 || sftpStatusFailure != 4 || sftpStatusOpUnsupported != 8 {
		t.Fatalf("unexpected SFTP v3 status codes: no-such=%d permission=%d failure=%d unsupported=%d", sftpStatusNoSuchFile, sftpStatusPermissionDenied, sftpStatusFailure, sftpStatusOpUnsupported)
	}
	for _, test := range []struct {
		err  error
		want uint32
	}{
		{err: os.ErrNotExist, want: sftpStatusNoSuchFile},
		{err: os.ErrPermission, want: sftpStatusPermissionDenied},
		{err: errors.New("other"), want: sftpStatusFailure},
	} {
		var protocolError *shellSFTPError
		if !errors.As(shellErrorFromOS(test.err), &protocolError) || protocolError.code != test.want {
			t.Fatalf("shellErrorFromOS(%v) code=%v, want %d", test.err, protocolError, test.want)
		}
	}
	content, err := os.ReadFile("go.mod")
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(content, []byte("github.com/pkg/sftp")) {
		t.Fatal("go.mod still depends on github.com/pkg/sftp")
	}
}

func TestSFTPExtensionsAndRetainedHandleAfterRename(t *testing.T) {
	requireOpenSSH(t, "sftp")
	shared := t.TempDir()
	original := filepath.Join(shared, "original.txt")
	renamed := filepath.Join(shared, "renamed.txt")
	if err := os.WriteFile(original, []byte("original"), 0600); err != nil {
		t.Fatal(err)
	}
	fixture := newShellSSHFixture(t, shellPolicy{Reach: "deployment", Shares: []shellSharePolicy{{Path: filepath.ToSlash(shared), Mode: "read-write"}}})
	command := exec.Command("sftp", "-vvv", "-b", "-", "-F", fixture.config, "test")
	command.Env = fixture.environment()
	command.Stdin = strings.NewReader("quit\n")
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("OpenSSH extension negotiation failed: %v\n%s", err, output)
	}
	for _, extension := range []string{"expand-path@openssh.com", "fsync@openssh.com", "posix-rename@openssh.com"} {
		if !strings.Contains(string(output), extension) {
			t.Fatalf("OpenSSH did not observe %s:\n%s", extension, output)
		}
	}
	assertExpandPathExtension(t, fixture)

	client, closeClient := fixture.goSFTPClient(t)
	defer closeClient()
	file, err := client.OpenFile(filepath.ToSlash(original), os.O_RDWR)
	if err != nil {
		t.Fatal(err)
	}
	if err := client.PosixRename(filepath.ToSlash(original), filepath.ToSlash(renamed)); err != nil {
		t.Fatal(err)
	}
	if err := file.Chmod(0640); err != nil {
		t.Fatalf("FSETSTAT after rename failed: %v", err)
	}
	if err := file.Sync(); err != nil {
		t.Fatalf("FSYNC on retained handle failed: %v", err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	retainedInfo, err := os.Stat(renamed)
	if err != nil || retainedInfo.Mode().Perm() != 0640 {
		t.Fatalf("retained handle did not update renamed file: %#v error=%v", retainedInfo, err)
	}
	if err := client.Link(filepath.ToSlash(renamed), filepath.ToSlash(filepath.Join(shared, "hard-link"))); err == nil {
		t.Fatal("hard-link creation was accepted")
	}
	changedAt := time.Unix(1_700_000_000, 0)
	if err := client.Truncate(filepath.ToSlash(renamed), 4); err != nil {
		t.Fatalf("named SETSTAT size failed: %v", err)
	}
	if err := client.Chmod(filepath.ToSlash(renamed), 0604); err != nil {
		t.Fatalf("named SETSTAT permissions failed: %v", err)
	}
	if err := client.Chtimes(filepath.ToSlash(renamed), changedAt, changedAt); err != nil {
		t.Fatalf("named SETSTAT times failed: %v", err)
	}
	info, err := os.Stat(renamed)
	if err != nil || info.Mode().Perm() != 0604 || info.Size() != 4 || info.ModTime().Unix() != changedAt.Unix() {
		t.Fatalf("named SETSTAT info=%#v error=%v", info, err)
	}
	account, err := user.Current()
	if err != nil {
		t.Fatal(err)
	}
	resolved, err := client.RealPath("~")
	if err != nil || resolved != filepath.ToSlash(account.HomeDir) {
		t.Fatalf("REALPATH ~= %q, %v", resolved, err)
	}
}

func assertExpandPathExtension(t *testing.T, fixture *shellSSHFixture) {
	t.Helper()
	client, closeClient := fixture.goSSHClient(t)
	defer closeClient()
	channel, requests, err := client.OpenChannel("session", nil)
	if err != nil {
		t.Fatal(err)
	}
	go ssh.DiscardRequests(requests)
	accepted, err := channel.SendRequest("subsystem", true, ssh.Marshal(struct{ Name string }{"sftp"}))
	if err != nil || !accepted {
		t.Fatalf("sftp subsystem accepted=%t error=%v", accepted, err)
	}
	initPacket := &shellSFTPEncoder{}
	initPacket.uint32(3)
	writeRawSFTPPacket(t, channel, sftpPacketInit, initPacket.bytes())
	packetType, _, err := readRawSFTPPacket(channel)
	if err != nil || packetType != sftpPacketVersion {
		t.Fatalf("SFTP version packet type=%d error=%v", packetType, err)
	}
	request := &shellSFTPEncoder{}
	request.uint32(41)
	request.string("expand-path@openssh.com")
	request.string("~")
	writeRawSFTPPacket(t, channel, sftpPacketExtended, request.bytes())
	packetType, payload, err := readRawSFTPPacket(channel)
	if err != nil || packetType != sftpPacketName {
		t.Fatalf("expand-path packet type=%d error=%v", packetType, err)
	}
	decoder := shellSFTPDecoder{content: payload}
	id, _ := decoder.uint32()
	count, _ := decoder.uint32()
	name, nameErr := decoder.string(maxSFTPPacketBytes)
	account, userErr := user.Current()
	if id != 41 || count != 1 || nameErr != nil || userErr != nil || name != filepath.ToSlash(account.HomeDir) {
		t.Fatalf("expand-path id=%d count=%d name=%q nameErr=%v userErr=%v", id, count, name, nameErr, userErr)
	}
	_ = channel.Close()
}

func writeRawSFTPPacket(t *testing.T, writer io.Writer, packetType byte, payload []byte) {
	t.Helper()
	content := make([]byte, len(payload)+5)
	binary.BigEndian.PutUint32(content[:4], uint32(len(payload)+1))
	content[4] = packetType
	copy(content[5:], payload)
	if _, err := writer.Write(content); err != nil {
		t.Fatal(err)
	}
}

func readRawSFTPPacket(reader io.Reader) (byte, []byte, error) {
	var length [4]byte
	if _, err := io.ReadFull(reader, length[:]); err != nil {
		return 0, nil, err
	}
	size := binary.BigEndian.Uint32(length[:])
	if size < 1 || size > maxSFTPPacketBytes {
		return 0, nil, errors.New("invalid SFTP test response length")
	}
	content := make([]byte, size)
	if _, err := io.ReadFull(reader, content); err != nil {
		return 0, nil, err
	}
	return content[0], content[1:], nil
}

func TestShellIdleTimeoutIgnoresTransportKeepalives(t *testing.T) {
	requireOpenSSH(t, "ssh")
	fixture := newShellSSHFixtureWithIdle(t, shellPolicy{Reach: "deployment", Commands: true}, 2200*time.Millisecond)
	command := exec.Command("ssh", "-F", fixture.config, "-o", "ServerAliveInterval=1", "-o", "ServerAliveCountMax=10", "test", "sleep 30")
	command.Env = fixture.environment()
	started := time.Now()
	output, err := command.CombinedOutput()
	if err == nil || time.Since(started) > 6*time.Second {
		t.Fatalf("idle session did not close on time: %v output=%q elapsed=%s", err, output, time.Since(started))
	}
	ended := recordWithKind(fixture.records(t), "session.end")
	if ended == nil || ended["reason"] != "idle-timeout" {
		t.Fatalf("missing idle lifecycle record: %#v", fixture.records(t))
	}
}

func TestShellDisconnectTerminatesProcessGroup(t *testing.T) {
	requireOpenSSH(t, "ssh")
	fixture := newShellSSHFixture(t, shellPolicy{Reach: "deployment", Commands: true})
	pidPath := filepath.Join(t.TempDir(), "child.pid")
	command := fixture.sshCommand(fmt.Sprintf("sleep 60 & echo $! > %s; wait", shellQuote(pidPath)))
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	var childPID int
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		content, err := os.ReadFile(pidPath)
		if err == nil {
			childPID, _ = strconv.Atoi(strings.TrimSpace(string(content)))
			if childPID > 0 {
				break
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	if childPID == 0 {
		_ = command.Process.Kill()
		t.Fatal("remote child pid was not published")
	}
	if err := command.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	_ = command.Wait()
	for deadline = time.Now().Add(7 * time.Second); time.Now().Before(deadline); {
		err := syscall.Kill(childPID, 0)
		if errors.Is(err, syscall.ESRCH) {
			break
		}
		time.Sleep(30 * time.Millisecond)
	}
	if err := syscall.Kill(childPID, 0); !errors.Is(err, syscall.ESRCH) {
		t.Fatalf("remote process %d survived disconnect: %v", childPID, err)
	}
	recordDeadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(recordDeadline) {
		records := fixture.recordsIfPresent()
		if recordsContain(records, "process.started") && recordsContain(records, "process.exited") {
			for _, record := range records {
				if record["kind"] == "channel.closed" {
					if _, hasStatus := record["exitStatus"]; hasStatus {
						t.Fatalf("disconnect audit claimed an exit status: %#v", record)
					}
					if _, hasSignal := record["exitSignal"]; hasSignal {
						t.Fatalf("disconnect audit claimed an exit signal: %#v", record)
					}
					return
				}
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("missing process lifecycle records: %#v", fixture.recordsIfPresent())
}

func TestShellExitStatusPrecedesProcessGroupSweep(t *testing.T) {
	fixture := newShellSSHFixture(t, shellPolicy{Reach: "deployment", Commands: true})
	client, closeClient := fixture.goSSHClient(t)
	defer closeClient()
	channel, requests, err := client.OpenChannel("session", nil)
	if err != nil {
		t.Fatal(err)
	}
	pidPath := filepath.Join(t.TempDir(), "background.pid")
	commandText := fmt.Sprintf("trap '' TERM; sleep 30 </dev/null >/dev/null 2>&1 & echo $! > %s", shellQuote(pidPath))
	started := time.Now()
	accepted, err := channel.SendRequest("exec", true, ssh.Marshal(struct{ Command string }{commandText}))
	if err != nil || !accepted {
		t.Fatalf("exec accepted=%t error=%v", accepted, err)
	}
	select {
	case request, ok := <-requests:
		elapsed := time.Since(started)
		if !ok || request.Type != "exit-status" || elapsed >= time.Second {
			t.Fatalf("exit status waited for process-group sweep: request=%v elapsed=%s", request, elapsed)
		}
		var payload struct{ Status uint32 }
		if err := ssh.Unmarshal(request.Payload, &payload); err != nil || payload.Status != 0 {
			t.Fatalf("exit status payload=%d error=%v", payload.Status, err)
		}
	case <-time.After(time.Second):
		t.Fatal("exit status waited for process-group sweep")
	}
	content, err := os.ReadFile(pidPath)
	if err != nil {
		t.Fatal(err)
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(content)))
	if err != nil || pid < 1 {
		t.Fatalf("background pid=%q error=%v", content, err)
	}
	if err := syscall.Kill(pid, 0); err != nil {
		t.Fatalf("background process was not alive while status returned: %v", err)
	}
	deadline := time.Now().Add(processKillDelay + 2*time.Second)
	for time.Now().Before(deadline) {
		if err := syscall.Kill(pid, 0); errors.Is(err, syscall.ESRCH) {
			return
		}
		time.Sleep(30 * time.Millisecond)
	}
	t.Fatalf("background process %d survived the process-group sweep", pid)
}

func TestShellDisconnectKillsTermIgnoringProcessGroupAfterGrace(t *testing.T) {
	requireOpenSSH(t, "ssh")
	fixture := newShellSSHFixture(t, shellPolicy{Reach: "deployment", Commands: true})
	pidPath := filepath.Join(t.TempDir(), "group.pid")
	command := fixture.sshCommand(fmt.Sprintf("trap '' TERM; echo $$ > %s; while :; do sleep 1; done", shellQuote(pidPath)))
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	pid := waitForShellPID(t, pidPath, command)
	started := time.Now()
	if err := command.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	_ = command.Wait()
	deadline := time.Now().Add(7 * time.Second)
	for time.Now().Before(deadline) {
		if err := syscall.Kill(pid, 0); errors.Is(err, syscall.ESRCH) {
			if time.Since(started) < 4*time.Second {
				t.Fatalf("SIGKILL arrived before the five-second grace: %s", time.Since(started))
			}
			return
		}
		time.Sleep(30 * time.Millisecond)
	}
	t.Fatalf("TERM-ignoring process group %d survived the SIGKILL deadline", pid)
}

func waitForShellPID(t *testing.T, path string, command *exec.Cmd) int {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		content, err := os.ReadFile(path)
		if err == nil {
			pid, parseErr := strconv.Atoi(strings.TrimSpace(string(content)))
			if parseErr == nil && pid > 0 {
				return pid
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	_ = command.Process.Kill()
	t.Fatal("remote process pid was not published")
	return 0
}

func TestShellAuditOverflowEmitsLossLifecycle(t *testing.T) {
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	emitter, err := newShellRecordEmitter(writer)
	if err != nil {
		t.Fatal(err)
	}
	if err := emitter.lifecycle(map[string]any{"kind": "ready"}); err != nil {
		t.Fatal(err)
	}
	detail := strings.Repeat("x", 500)
	for index := 0; index < 20_000; index++ {
		emitter.audit(map[string]any{"kind": "denied", "channel": 1, "what": "env", "detail": detail})
	}
	var content bytes.Buffer
	drained := make(chan struct{})
	go func() {
		_, _ = io.Copy(&content, reader)
		close(drained)
	}()
	if err := emitter.lifecycle(map[string]any{"kind": "session.end", "reason": "idle-timeout"}); err != nil {
		t.Fatal(err)
	}
	emitter.close()
	_ = reader.Close()
	<-drained
	if !bytes.Contains(content.Bytes(), []byte(`"kind":"audit.dropped"`)) {
		t.Fatalf("audit loss was not reported; bytes=%d", content.Len())
	}
	scanner := bufio.NewScanner(bytes.NewReader(content.Bytes()))
	buffer := make([]byte, maxShellRecordBytes+1)
	scanner.Buffer(buffer, maxShellRecordBytes+1)
	for scanner.Scan() {
		if len(scanner.Bytes())+1 > maxShellRecordBytes {
			t.Fatalf("record exceeded 8 KiB: %d", len(scanner.Bytes())+1)
		}
	}
	if err := scanner.Err(); err != nil {
		t.Fatal(err)
	}
}

func TestShellAuditWriteDropsIntactRecordWhenNonblockingPipeIsFull(t *testing.T) {
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	defer writer.Close()
	writeFD := int(writer.Fd())
	if err := unix.SetNonblock(writeFD, true); err != nil {
		t.Fatal(err)
	}

	filler := bytes.Repeat([]byte("f"), 4096)
	filled := 0
	for {
		count, writeErr := unix.Write(writeFD, filler)
		if count > 0 {
			filled += count
		}
		if errors.Is(writeErr, unix.EAGAIN) || errors.Is(writeErr, unix.EWOULDBLOCK) {
			break
		}
		if writeErr != nil {
			t.Fatal(writeErr)
		}
		if count == 0 {
			t.Fatal("filling nonblocking pipe made no progress")
		}
	}
	if filled == 0 {
		t.Fatal("nonblocking pipe reported full before accepting bytes")
	}

	emitter := &shellRecordEmitter{fd: writeFD, file: writer}
	record := []byte("{\"kind\":\"denied\"}\n")
	if err := emitter.writeRecord(record, false); !errors.Is(err, errShellRecordDropped) {
		t.Fatalf("full-pipe audit write error = %v", err)
	}
	drained := make([]byte, filled)
	if _, err := io.ReadFull(reader, drained); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(drained, bytes.Repeat([]byte("f"), filled)) {
		t.Fatal("dropped audit record corrupted bytes already in the pipe")
	}

	if err := emitter.writeRecord(record, false); err != nil {
		t.Fatal(err)
	}
	written := make([]byte, len(record))
	if _, err := io.ReadFull(reader, written); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(written, record) {
		t.Fatalf("record after drain = %q, want %q", written, record)
	}
}

func TestOpenSSHForwardingPolicyAndGlobalRequestRefusal(t *testing.T) {
	requireOpenSSH(t, "ssh")
	// Bound this test's network and child-process work, rather than the whole Go package.
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	defer func() {
		if ctx.Err() != nil {
			t.Errorf("forwarding fixture deadline: %v", ctx.Err())
		}
	}()
	target, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer target.Close()
	stopAccept := context.AfterFunc(ctx, func() { target.Close() })
	defer stopAccept()
	echoDone := make(chan error, 1)
	go func() {
		connection, acceptErr := acceptFixturePing(ctx, target)
		if acceptErr != nil {
			echoDone <- acceptErr
			return
		}
		defer connection.Close()
		stopPeer := context.AfterFunc(ctx, func() { connection.Close() })
		defer stopPeer()
		if deadline, ok := ctx.Deadline(); ok {
			_ = connection.SetDeadline(deadline)
		}
		_, writeErr := connection.Write([]byte("ping"))
		echoDone <- writeErr
	}()
	probeFixtureListener(t, ctx, target.Addr().String())
	localProbe, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	localPort := localProbe.Addr().(*net.TCPAddr).Port
	_ = localProbe.Close()
	targetPort := target.Addr().(*net.TCPAddr).Port
	allowed := newShellSSHFixture(t, shellPolicy{Reach: "deployment", Forwarding: true})
	forward := exec.CommandContext(ctx, "ssh", "-F", allowed.config, "-N", "-o", "ExitOnForwardFailure=yes", "-L", fmt.Sprintf("127.0.0.1:%d:127.0.0.1:%d", localPort, targetPort), "test")
	forward.Env = allowed.environment()
	if err := forward.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = forward.Process.Kill()
		_ = forward.Wait()
	})
	var connection net.Conn
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		connection, err = (&net.Dialer{Timeout: 100 * time.Millisecond}).DialContext(ctx, "tcp", fmt.Sprintf("127.0.0.1:%d", localPort))
		if err == nil {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if err != nil {
		t.Fatalf("local forwarding listener did not start: %v", err)
	}
	defer connection.Close()
	if deadline, ok := ctx.Deadline(); ok {
		_ = connection.SetDeadline(deadline)
	}
	if _, err := connection.Write([]byte("ping")); err != nil {
		t.Fatal(err)
	}
	reply := make([]byte, 4)
	if _, err := io.ReadFull(connection, reply); err != nil || string(reply) != "ping" {
		t.Fatalf("forward reply=%q error=%v", reply, err)
	}
	_ = connection.Close()
	if err := <-echoDone; err != nil {
		t.Fatal(err)
	}
	_ = forward.Process.Kill()
	_ = forward.Wait()
	if !recordsContain(allowed.records(t), "forward") {
		t.Fatal("allowed direct-tcpip did not emit forward audit")
	}

	denied := newShellSSHFixture(t, shellPolicy{Reach: "deployment", Forwarding: false})
	deniedProbe, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	deniedPort := deniedProbe.Addr().(*net.TCPAddr).Port
	_ = deniedProbe.Close()
	forward = exec.CommandContext(ctx, "ssh", "-F", denied.config, "-N", "-o", "ExitOnForwardFailure=yes", "-L", fmt.Sprintf("127.0.0.1:%d:127.0.0.1:%d", deniedPort, targetPort), "test")
	forward.Env = denied.environment()
	var forwardOutput bytes.Buffer
	forward.Stdout = &forwardOutput
	forward.Stderr = &forwardOutput
	if err := forward.Start(); err != nil {
		t.Fatal(err)
	}
	deadline = time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		connection, err = (&net.Dialer{Timeout: 100 * time.Millisecond}).DialContext(ctx, "tcp", fmt.Sprintf("127.0.0.1:%d", deniedPort))
		if err == nil {
			_, _ = connection.Write([]byte("x"))
			_ = connection.SetReadDeadline(time.Now().Add(time.Second))
			_, _ = connection.Read(make([]byte, 1))
			_ = connection.Close()
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	_ = forward.Process.Kill()
	_ = forward.Wait()
	foundDeniedForward := false
	for _, record := range denied.records(t) {
		if record["kind"] == "denied" && record["what"] == "forward" {
			foundDeniedForward = true
		}
	}
	if !foundDeniedForward {
		t.Fatalf("missing denied forward audit; output=%s", forwardOutput.String())
	}

	reverse := exec.CommandContext(ctx, "ssh", "-F", allowed.config, "-N", "-o", "ExitOnForwardFailure=yes", "-R", "0:127.0.0.1:1", "test")
	reverse.Env = allowed.environment()
	if output, err := reverse.CombinedOutput(); err == nil {
		t.Fatalf("reverse forwarding unexpectedly succeeded: %s", output)
	}
	foundGlobal := false
	for _, record := range allowed.records(t) {
		if record["kind"] == "denied" && record["what"] == "global-request" {
			foundGlobal = true
		}
	}
	if !foundGlobal {
		t.Fatal("missing denied tcpip-forward global-request audit")
	}
}

func TestShellForwardCleanupClosesTargetThatKeepsWriteSideOpen(t *testing.T) {

	// A peer can connect without completing its prefix; own cancellation independently of package timeout.
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	defer func() {
		if ctx.Err() != nil {
			t.Errorf("forward cleanup fixture deadline: %v", ctx.Err())
		}
	}()
	target, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer target.Close()
	accepted := make(chan net.Conn, 1)
	go func() {
		connection, acceptErr := acceptFixturePing(ctx, target)
		if acceptErr == nil {
			accepted <- connection
		}
	}()

	fixture := newShellSSHFixture(t, shellPolicy{Reach: "deployment", Forwarding: true})
	client, closeClient := fixture.goSSHClient(t)
	probeFixtureListener(t, ctx, target.Addr().String())
	forward, err := client.Dial("tcp", target.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer forward.Close()
	if _, err := forward.Write([]byte("ping")); err != nil {
		t.Fatal(err)
	}
	var targetConnection net.Conn
	select {
	case targetConnection = <-accepted:
	case <-time.After(2 * time.Second):
		t.Fatal("forward target was not connected")
	}
	defer targetConnection.Close()

	cleanupDone := make(chan struct{})
	go func() {
		closeClient()
		close(cleanupDone)
	}()
	select {
	case <-cleanupDone:
	case <-time.After(2 * time.Second):
		_ = targetConnection.Close()
		<-cleanupDone
		t.Fatal("SSH connection cleanup waited for the target to close its write side")
	}
}

type shellLifecycleOrderingCloser struct {
	closeCount atomic.Int32
	closed     chan []byte
	readFD     int
}

func (closer *shellLifecycleOrderingCloser) Close() error {
	closer.closeCount.Add(1)
	content := make([]byte, maxShellRecordBytes)
	count, _ := unix.Read(closer.readFD, content)
	closer.closed <- content[:max(count, 0)]
	return nil
}

func TestShellCleanupIsIdempotentAndIdleRecordPrecedesConnectionClose(t *testing.T) {
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	readFD := int(reader.Fd())
	if err := unix.SetNonblock(readFD, true); err != nil {
		t.Fatal(err)
	}
	emitter, err := newShellRecordEmitter(writer)
	if err != nil {
		t.Fatal(err)
	}
	defer emitter.close()
	closer := &shellLifecycleOrderingCloser{closed: make(chan []byte, 1), readFD: readFD}
	session := &shellSession{
		cleanupDone: make(chan struct{}),
		connection:  closer,
		emitter:     emitter,
		forwards:    make(map[*trackedShellForward]struct{}),
		idle:        newShellIdleClock(20 * time.Millisecond),
		processes:   make(map[int]*trackedShellProcess),
	}
	go session.watchIdle()

	select {
	case content := <-closer.closed:
		if !bytes.Contains(content, []byte(`{"kind":"session.end","reason":"idle-timeout"}`)) {
			t.Fatalf("connection closed before idle lifecycle record was available: %q", content)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("idle cleanup did not close the connection")
	}

	var cleanupWG sync.WaitGroup
	for index := 0; index < 8; index++ {
		cleanupWG.Add(1)
		go func() {
			defer cleanupWG.Done()
			session.cleanupSession()
		}()
	}
	cleanupWG.Wait()
	if count := closer.closeCount.Load(); count != 1 {
		t.Fatalf("idle and transport-loss cleanup closed the connection %d times", count)
	}
}

func TestShellInitPreservesBufferedSSHBytesAndReadyPrecedesHandshake(t *testing.T) {
	fixture := newShellSSHFixture(t, shellPolicy{Reach: "deployment"})
	initContent, err := base64.RawStdEncoding.DecodeString(fixture.initEncoded)
	if err != nil {
		t.Fatal(err)
	}
	var frame bytes.Buffer
	if err := binary.Write(&frame, binary.BigEndian, uint32(len(initContent))); err != nil {
		t.Fatal(err)
	}
	frame.Write(initContent)
	frame.WriteString("SSH-BUFFERED")
	reader, _, _, err := readShellInit(bytes.NewReader(frame.Bytes()))
	if err != nil {
		t.Fatal(err)
	}
	remaining, err := io.ReadAll(reader)
	if err != nil || string(remaining) != "SSH-BUFFERED" {
		t.Fatalf("buffered bytes=%q error=%v", remaining, err)
	}

	command := exec.Command(shellTestBinary, "shell-serve")
	command.Env = append(os.Environ(), "SHELL=/bin/sh")
	stdin, err := command.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	recordReader, recordWriter, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	command.ExtraFiles = []*os.File{recordWriter}
	command.Stdout = io.Discard
	command.Stderr = os.Stderr
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	_ = recordWriter.Close()
	if _, err := stdin.Write(frame.Bytes()[:4+len(initContent)]); err != nil {
		t.Fatal(err)
	}
	lineResult := make(chan string, 1)
	go func() {
		line, _ := bufio.NewReader(recordReader).ReadString('\n')
		lineResult <- line
	}()
	select {
	case line := <-lineResult:
		if line != "{\"kind\":\"ready\"}\n" {
			t.Fatalf("first lifecycle record=%q", line)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("ready was not emitted before the SSH handshake")
	}
	_ = stdin.Close()
	if err := command.Wait(); err != nil {
		t.Fatalf("EOF cleanup exit: %v", err)
	}
	_ = recordReader.Close()
}

func TestSSHSessionRequestRefusalsAndChannelLimit(t *testing.T) {
	fixture := newShellSSHFixture(t, shellPolicy{Reach: "deployment", Commands: true})
	client, closeClient := fixture.goSSHClient(t)
	defer closeClient()
	if accepted, _, err := client.SendRequest("keepalive@openssh.com", true, nil); err != nil || !accepted {
		t.Fatalf("keepalive accepted=%t error=%v", accepted, err)
	}
	for _, request := range []string{"tcpip-forward", "cancel-tcpip-forward", "unknown-global"} {
		if accepted, _, err := client.SendRequest(request, true, nil); err != nil || accepted {
			t.Fatalf("global %s accepted=%t error=%v", request, accepted, err)
		}
	}

	channel, requests, err := client.OpenChannel("session", nil)
	if err != nil {
		t.Fatal(err)
	}
	envAccepted, err := channel.SendRequest("env", true, ssh.Marshal(struct{ Name, Value string }{"TEST", "value"}))
	if err != nil || envAccepted {
		t.Fatalf("env accepted=%t error=%v", envAccepted, err)
	}
	subsystemAccepted, err := channel.SendRequest("subsystem", true, ssh.Marshal(struct{ Name string }{"unknown"}))
	if err != nil || subsystemAccepted {
		t.Fatalf("unknown subsystem accepted=%t error=%v", subsystemAccepted, err)
	}
	agentAccepted, err := channel.SendRequest("auth-agent-req@openssh.com", true, nil)
	if err != nil || agentAccepted {
		t.Fatalf("agent forwarding accepted=%t error=%v", agentAccepted, err)
	}
	x11Accepted, err := channel.SendRequest("x11-req", true, nil)
	if err != nil || x11Accepted {
		t.Fatalf("x11 accepted=%t error=%v", x11Accepted, err)
	}
	_ = channel.Close()
	for range requests {
	}

	terminal, terminalRequests, err := client.OpenChannel("session", nil)
	if err != nil {
		t.Fatal(err)
	}
	ptyPayload := struct {
		Term          string
		Columns, Rows uint32
		Width, Height uint32
		TerminalModes string
	}{Term: "xterm", Columns: 80, Rows: 24}
	// A terminal request is refused without ending the channel: the client
	// reports the refusal and carries on to the request it actually meant.
	ptyAccepted, err := terminal.SendRequest("pty-req", true, ssh.Marshal(ptyPayload))
	if err != nil || ptyAccepted {
		t.Fatalf("pty accepted=%t error=%v", ptyAccepted, err)
	}
	terminalShellAccepted, err := terminal.SendRequest("shell", true, nil)
	if err != nil || !terminalShellAccepted {
		t.Fatalf("shell after pty accepted=%t error=%v", terminalShellAccepted, err)
	}
	stderr, err := io.ReadAll(terminal.Stderr())
	if err != nil || string(stderr) != "Opensteer does not provide interactive terminals; run a command.\n" {
		t.Fatalf("pty stderr=%q error=%v", stderr, err)
	}
	exitStatus := uint32(0)
	for request := range terminalRequests {
		if request.Type == "exit-status" {
			var payload struct{ Status uint32 }
			_ = ssh.Unmarshal(request.Payload, &payload)
			exitStatus = payload.Status
		}
	}
	if exitStatus != 126 {
		t.Fatalf("pty exit status=%d", exitStatus)
	}
	shellChannel, shellRequests, err := client.OpenChannel("session", nil)
	if err != nil {
		t.Fatal(err)
	}
	shellAccepted, err := shellChannel.SendRequest("shell", true, nil)
	if err != nil || !shellAccepted {
		t.Fatalf("shell accepted=%t error=%v", shellAccepted, err)
	}
	shellStderr, err := io.ReadAll(shellChannel.Stderr())
	if err != nil || string(shellStderr) != "Opensteer does not provide interactive terminals; run a command.\n" {
		t.Fatalf("shell stderr=%q error=%v", shellStderr, err)
	}
	for range shellRequests {
	}

	execChannel, execRequests, err := client.OpenChannel("session", nil)
	if err != nil {
		t.Fatal(err)
	}
	first, err := execChannel.SendRequest("exec", true, ssh.Marshal(struct{ Command string }{"sleep 30"}))
	if err != nil || !first {
		t.Fatalf("first exec accepted=%t error=%v", first, err)
	}
	second, err := execChannel.SendRequest("exec", true, ssh.Marshal(struct{ Command string }{"true"}))
	if err != nil || second {
		t.Fatalf("second exec accepted=%t error=%v", second, err)
	}
	_ = execChannel.Close()
	for range execRequests {
	}

	if _, _, err := client.OpenChannel("unknown-opensteer-test", nil); err == nil {
		t.Fatal("unknown channel type was accepted")
	}
	// The server frees a command channel's slot after its close reply has gone
	// out, so the session above may still count the exec channel. A fresh
	// session counts only the channels opened here.
	limitClient, closeLimitClient := fixture.goSSHClient(t)
	defer closeLimitClient()
	channels := make([]ssh.Channel, 0, maxShellChannels)
	for index := 0; index < maxShellChannels; index++ {
		opened, requestStream, err := limitClient.OpenChannel("session", nil)
		if err != nil {
			t.Fatalf("open channel %d: %v", index, err)
		}
		channels = append(channels, opened)
		go ssh.DiscardRequests(requestStream)
	}
	if overflow, _, err := limitClient.OpenChannel("session", nil); err == nil {
		_ = overflow.Close()
		t.Fatal("65th channel was accepted")
	}
	for _, opened := range channels {
		_ = opened.Close()
	}
}

type shellSSHFixture struct {
	config      string
	initEncoded string
	recordPath  string
}

func newShellSSHFixture(t *testing.T, policy shellPolicy) *shellSSHFixture {
	return newShellSSHFixtureWithIdle(t, policy, 0)
}

func newShellSSHFixtureWithIdle(t *testing.T, policy shellPolicy, idle time.Duration) *shellSSHFixture {
	t.Helper()
	if policy.Shares == nil {
		policy.Shares = []shellSharePolicy{}
	}
	directory := t.TempDir()
	keyDirectory := filepath.Join(directory, "keys")
	publicKey := strings.TrimSpace(runTestBinary(t, nil, "shell-keygen", "--out", keyDirectory))
	recordPath := filepath.Join(directory, "records.jsonl")
	init := shellInit{
		Authority: shellAuthority{
			CallerMachineName: "caller", PolicyRevision: 1, RequestedBy: "usr_test", RunID: "run_test",
			SessionID: "shell_test", StartedAt: time.Now().UTC().Format(time.RFC3339Nano), ThreadID: "thr_test",
			ThreadTitle: "Shell helper test", WorkspaceID: "ws_test",
		},
		HostKeyPath: filepath.Join(keyDirectory, shellHostKeyName),
		MachineName: "Target Mac",
		Policy:      policy,
	}
	if idle > 0 {
		milliseconds := idle.Milliseconds()
		init.IdleTimeout = &milliseconds
	}
	content, err := json.Marshal(init)
	if err != nil {
		t.Fatal(err)
	}
	testBinary, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	configPath := filepath.Join(directory, "ssh_config")
	knownHosts := filepath.Join(directory, "known_hosts")
	if err := os.WriteFile(knownHosts, []byte("opensteer-test "+publicKey+"\n"), 0600); err != nil {
		t.Fatal(err)
	}
	proxy := shellQuote(testBinary) + " -test.run=TestShellProxyProcess --"
	config := fmt.Sprintf("Host test\n  HostName opensteer-test\n  User opensteer\n  ProxyCommand %s\n  UserKnownHostsFile %s\n  GlobalKnownHostsFile /dev/null\n  StrictHostKeyChecking yes\n  CheckHostIP no\n  IdentitiesOnly yes\n  IdentityFile none\n  IdentityAgent none\n  PreferredAuthentications none\n  BatchMode yes\n  RequestTTY no\n  LogLevel ERROR\n", proxy, shellQuote(knownHosts))
	if err := os.WriteFile(configPath, []byte(config), 0600); err != nil {
		t.Fatal(err)
	}
	return &shellSSHFixture{config: configPath, initEncoded: base64.RawStdEncoding.EncodeToString(content), recordPath: recordPath}
}

func (fixture *shellSSHFixture) environment() []string {
	return append(os.Environ(),
		"OPENSTEER_SHELL_TEST_PROXY=1",
		"OPENSTEER_SHELL_TEST_INIT="+fixture.initEncoded,
		"OPENSTEER_SHELL_TEST_RECORDS="+fixture.recordPath,
		"OPENSTEER_SHELL_TEST_DRAIN=1",
	)
}

func (fixture *shellSSHFixture) sshCommand(command string) *exec.Cmd {
	value := exec.Command("ssh", "-F", fixture.config, "test", command)
	value.Env = fixture.environment()
	return value
}

func (fixture *shellSSHFixture) sftpBatch(batch string) *exec.Cmd {
	value := exec.Command("sftp", "-b", "-", "-F", fixture.config, "test")
	value.Env = fixture.environment()
	value.Stdin = strings.NewReader(batch)
	return value
}

type shellTestSFTPClient struct {
	channel ssh.Channel
	nextID  uint32
}

type shellTestSFTPFile struct {
	client *shellTestSFTPClient
	handle string
}

func (client *shellTestSFTPClient) request(packetType byte, encode func(*shellSFTPEncoder)) (byte, shellSFTPDecoder, error) {
	client.nextID++
	request := &shellSFTPEncoder{}
	request.uint32(client.nextID)
	encode(request)
	if err := writeShellTestSFTPPacket(client.channel, packetType, request.bytes()); err != nil {
		return 0, shellSFTPDecoder{}, err
	}
	responseType, payload, err := readRawSFTPPacket(client.channel)
	if err != nil {
		return 0, shellSFTPDecoder{}, err
	}
	decoder := shellSFTPDecoder{content: payload}
	id, err := decoder.uint32()
	if err != nil || id != client.nextID {
		return 0, shellSFTPDecoder{}, errors.New("invalid SFTP test response id")
	}
	if responseType == sftpPacketStatus {
		code, codeErr := decoder.uint32()
		message, messageErr := decoder.string(maxSFTPPacketBytes)
		if codeErr != nil || messageErr != nil {
			return 0, shellSFTPDecoder{}, errors.New("invalid SFTP test status")
		}
		if code != sftpStatusOK {
			return responseType, decoder, fmt.Errorf("SFTP status %d: %s", code, message)
		}
	}
	return responseType, decoder, nil
}

func (client *shellTestSFTPClient) OpenFile(name string, flags int) (*shellTestSFTPFile, error) {
	protocolFlags := uint32(0)
	if flags&os.O_RDWR != 0 {
		protocolFlags |= sftpOpenRead | sftpOpenWrite
	} else if flags&os.O_WRONLY != 0 {
		protocolFlags |= sftpOpenWrite
	} else {
		protocolFlags |= sftpOpenRead
	}
	if flags&os.O_APPEND != 0 {
		protocolFlags |= sftpOpenAppend
	}
	if flags&os.O_CREATE != 0 {
		protocolFlags |= sftpOpenCreate
	}
	if flags&os.O_TRUNC != 0 {
		protocolFlags |= sftpOpenTrunc
	}
	if flags&os.O_EXCL != 0 {
		protocolFlags |= sftpOpenExcl
	}
	packetType, decoder, err := client.request(sftpPacketOpen, func(request *shellSFTPEncoder) {
		request.string(name)
		request.uint32(protocolFlags)
		request.uint32(0)
	})
	if err != nil {
		return nil, err
	}
	if packetType != sftpPacketHandle {
		return nil, errors.New("SFTP OPEN did not return a handle")
	}
	handle, err := decoder.string(128)
	if err != nil || decoder.remaining() != 0 {
		return nil, errors.New("invalid SFTP handle response")
	}
	return &shellTestSFTPFile{client: client, handle: handle}, nil
}

func (client *shellTestSFTPClient) PosixRename(oldName, newName string) error {
	_, _, err := client.request(sftpPacketExtended, func(request *shellSFTPEncoder) {
		request.string("posix-rename@openssh.com")
		request.string(oldName)
		request.string(newName)
	})
	return err
}

func (client *shellTestSFTPClient) Link(oldName, newName string) error {
	_, _, err := client.request(sftpPacketExtended, func(request *shellSFTPEncoder) {
		request.string("hardlink@openssh.com")
		request.string(oldName)
		request.string(newName)
	})
	return err
}

func (client *shellTestSFTPClient) setstat(name string, flags uint32, encode func(*shellSFTPEncoder)) error {
	_, _, err := client.request(sftpPacketSetstat, func(request *shellSFTPEncoder) {
		request.string(name)
		request.uint32(flags)
		encode(request)
	})
	return err
}

func (client *shellTestSFTPClient) Truncate(name string, size int64) error {
	return client.setstat(name, sftpAttrSize, func(request *shellSFTPEncoder) { request.uint64(uint64(size)) })
}

func (client *shellTestSFTPClient) Chmod(name string, mode os.FileMode) error {
	return client.setstat(name, sftpAttrPermissions, func(request *shellSFTPEncoder) { request.uint32(uint32(mode.Perm())) })
}

func (client *shellTestSFTPClient) Chtimes(name string, atime, mtime time.Time) error {
	return client.setstat(name, sftpAttrTimes, func(request *shellSFTPEncoder) {
		request.uint32(uint32(atime.Unix()))
		request.uint32(uint32(mtime.Unix()))
	})
}

func (client *shellTestSFTPClient) RealPath(name string) (string, error) {
	packetType, decoder, err := client.request(sftpPacketRealpath, func(request *shellSFTPEncoder) { request.string(name) })
	if err != nil {
		return "", err
	}
	if packetType != sftpPacketName {
		return "", errors.New("SFTP REALPATH did not return a name")
	}
	count, err := decoder.uint32()
	if err != nil || count != 1 {
		return "", errors.New("invalid SFTP REALPATH response")
	}
	resolved, err := decoder.string(maxSFTPPacketBytes)
	return resolved, err
}

func (client *shellTestSFTPClient) ReadDir(name string) ([]string, error) {
	packetType, decoder, err := client.request(sftpPacketOpendir, func(request *shellSFTPEncoder) { request.string(name) })
	if err != nil {
		return nil, err
	}
	if packetType != sftpPacketHandle {
		return nil, errors.New("SFTP OPENDIR did not return a handle")
	}
	handle, err := decoder.string(128)
	if err != nil {
		return nil, err
	}
	defer func() { _ = client.closeHandle(handle) }()
	var names []string
	for {
		packetType, decoder, err = client.request(sftpPacketReaddir, func(request *shellSFTPEncoder) { request.string(handle) })
		if err != nil {
			if strings.HasPrefix(err.Error(), fmt.Sprintf("SFTP status %d:", sftpStatusEOF)) {
				return names, nil
			}
			return nil, err
		}
		if packetType != sftpPacketName {
			return nil, errors.New("SFTP READDIR did not return names")
		}
		count, decodeErr := decoder.uint32()
		if decodeErr != nil {
			return nil, decodeErr
		}
		for index := uint32(0); index < count; index++ {
			entryName, nameErr := decoder.string(maxSFTPPacketBytes)
			_, longNameErr := decoder.string(maxSFTPPacketBytes)
			_, attrsErr := decoder.attrs()
			if nameErr != nil || longNameErr != nil || attrsErr != nil {
				return nil, errors.New("invalid SFTP NAME response")
			}
			names = append(names, entryName)
		}
	}
}

func (client *shellTestSFTPClient) closeHandle(handle string) error {
	_, _, err := client.request(sftpPacketClose, func(request *shellSFTPEncoder) { request.string(handle) })
	return err
}

func (file *shellTestSFTPFile) Chmod(mode os.FileMode) error {
	_, _, err := file.client.request(sftpPacketFsetstat, func(request *shellSFTPEncoder) {
		request.string(file.handle)
		request.uint32(sftpAttrPermissions)
		request.uint32(uint32(mode.Perm()))
	})
	return err
}

func (file *shellTestSFTPFile) Sync() error {
	_, _, err := file.client.request(sftpPacketExtended, func(request *shellSFTPEncoder) {
		request.string("fsync@openssh.com")
		request.string(file.handle)
	})
	return err
}

func (file *shellTestSFTPFile) Close() error { return file.client.closeHandle(file.handle) }

func writeShellTestSFTPPacket(writer io.Writer, packetType byte, payload []byte) error {
	content := make([]byte, len(payload)+5)
	binary.BigEndian.PutUint32(content[:4], uint32(len(payload)+1))
	content[4] = packetType
	copy(content[5:], payload)
	_, err := writer.Write(content)
	return err
}

func (fixture *shellSSHFixture) goSFTPClient(t *testing.T) (*shellTestSFTPClient, func()) {
	t.Helper()
	sshClient, closeSSH := fixture.goSSHClient(t)
	channel, requests, err := sshClient.OpenChannel("session", nil)
	if err != nil {
		closeSSH()
		t.Fatal(err)
	}
	go ssh.DiscardRequests(requests)
	accepted, err := channel.SendRequest("subsystem", true, ssh.Marshal(struct{ Name string }{"sftp"}))
	if err != nil || !accepted {
		_ = channel.Close()
		closeSSH()
		t.Fatalf("sftp subsystem accepted=%t error=%v", accepted, err)
	}
	initPacket := &shellSFTPEncoder{}
	initPacket.uint32(3)
	if err := writeShellTestSFTPPacket(channel, sftpPacketInit, initPacket.bytes()); err != nil {
		_ = channel.Close()
		closeSSH()
		t.Fatal(err)
	}
	packetType, _, err := readRawSFTPPacket(channel)
	if err != nil || packetType != sftpPacketVersion {
		_ = channel.Close()
		closeSSH()
		t.Fatalf("SFTP version packet type=%d error=%v", packetType, err)
	}
	client := &shellTestSFTPClient{channel: channel}
	var once sync.Once
	closeClient := func() {
		once.Do(func() {
			_ = channel.Close()
			closeSSH()
		})
	}
	t.Cleanup(closeClient)
	return client, closeClient
}

func (fixture *shellSSHFixture) goSSHClient(t *testing.T) (*ssh.Client, func()) {
	t.Helper()
	initContent, err := base64.RawStdEncoding.DecodeString(fixture.initEncoded)
	if err != nil {
		t.Fatal(err)
	}
	command := exec.Command(shellTestBinary, "shell-serve")
	command.Env = append(os.Environ(), "SHELL=/bin/sh")
	stdin, err := command.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdout, err := command.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	recordReader, recordWriter, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	command.ExtraFiles = []*os.File{recordWriter}
	command.Stderr = os.Stderr
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	_ = recordWriter.Close()
	recordDone := make(chan struct{})
	go func() {
		defer close(recordDone)
		file, openErr := os.OpenFile(fixture.recordPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
		if openErr == nil {
			_, _ = io.Copy(file, recordReader)
			_ = file.Close()
		}
		_ = recordReader.Close()
	}()
	var length [4]byte
	binary.BigEndian.PutUint32(length[:], uint32(len(initContent)))
	if _, err := stdin.Write(append(length[:], initContent...)); err != nil {
		t.Fatal(err)
	}
	connection := &shellTestPipeConn{reader: stdout, writer: stdin}
	sshConnection, channels, requests, err := ssh.NewClientConn(connection, "opensteer-test", &ssh.ClientConfig{
		HostKeyCallback: ssh.InsecureIgnoreHostKey(),
		Timeout:         10 * time.Second,
		User:            "opensteer",
	})
	if err != nil {
		t.Fatal(err)
	}
	sshClient := ssh.NewClient(sshConnection, channels, requests)
	var once sync.Once
	closeClient := func() {
		once.Do(func() {
			_ = sshClient.Close()
			_ = command.Wait()
			<-recordDone
		})
	}
	t.Cleanup(closeClient)
	return sshClient, closeClient
}

type shellTestPipeConn struct {
	once   sync.Once
	reader io.Reader
	writer io.WriteCloser
}

func (connection *shellTestPipeConn) Read(target []byte) (int, error) {
	return connection.reader.Read(target)
}
func (connection *shellTestPipeConn) Write(content []byte) (int, error) {
	return connection.writer.Write(content)
}
func (connection *shellTestPipeConn) Close() error {
	var err error
	connection.once.Do(func() { err = connection.writer.Close() })
	return err
}
func (connection *shellTestPipeConn) LocalAddr() net.Addr              { return shellStdioAddr("test-local") }
func (connection *shellTestPipeConn) RemoteAddr() net.Addr             { return shellStdioAddr("test-remote") }
func (connection *shellTestPipeConn) SetDeadline(time.Time) error      { return nil }
func (connection *shellTestPipeConn) SetReadDeadline(time.Time) error  { return nil }
func (connection *shellTestPipeConn) SetWriteDeadline(time.Time) error { return nil }

func assertSFTPFailure(t *testing.T, fixture *shellSSHFixture, batch, contains string) {
	t.Helper()
	output, err := fixture.sftpBatch(batch).CombinedOutput()
	if err == nil {
		t.Fatalf("expected SFTP failure containing %q: output=%s", contains, output)
	}
	if strings.Contains(string(output), contains) {
		return
	}
	for _, record := range fixture.records(t) {
		if detail, ok := record["detail"].(string); ok && strings.Contains(detail, contains) {
			return
		}
	}
	if !strings.Contains(string(output), contains) {
		t.Fatalf("expected SFTP failure containing %q: %v\n%s", contains, err, output)
	}
}

func fixtureMissingShare(fixture *shellSSHFixture) string {
	content, _ := base64.RawStdEncoding.DecodeString(fixture.initEncoded)
	var init shellInit
	_ = json.Unmarshal(content, &init)
	for _, share := range init.Policy.Shares {
		if strings.HasSuffix(share.Path, "/missing") {
			return share.Path
		}
	}
	return "/missing"
}

func (fixture *shellSSHFixture) records(t *testing.T) []map[string]any {
	t.Helper()
	content, err := os.ReadFile(fixture.recordPath)
	if err != nil {
		t.Fatal(err)
	}
	var records []map[string]any
	scanner := bufio.NewScanner(bytes.NewReader(content))
	for scanner.Scan() {
		var record map[string]any
		if err := json.Unmarshal(scanner.Bytes(), &record); err != nil {
			t.Fatal(err)
		}
		records = append(records, record)
	}
	if err := scanner.Err(); err != nil {
		t.Fatal(err)
	}
	return records
}

// Blocks until a record satisfies the predicate, or fails the test with what
// was recorded instead.
func (fixture *shellSSHFixture) waitForRecord(t *testing.T, what string, matches func(record map[string]any) bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		for _, record := range fixture.recordsIfPresent() {
			if matches(record) {
				return
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("missing %s audit: %#v", what, fixture.recordsIfPresent())
}

func (fixture *shellSSHFixture) recordsIfPresent() []map[string]any {
	content, err := os.ReadFile(fixture.recordPath)
	if err != nil {
		return nil
	}
	var records []map[string]any
	scanner := bufio.NewScanner(bytes.NewReader(content))
	for scanner.Scan() {
		var record map[string]any
		if json.Unmarshal(scanner.Bytes(), &record) == nil {
			records = append(records, record)
		}
	}
	return records
}

func recordsContain(records []map[string]any, kind string) bool {
	return recordWithKind(records, kind) != nil
}

func recordWithKind(records []map[string]any, kind string) map[string]any {
	for _, record := range records {
		if record["kind"] == kind {
			return record
		}
	}
	return nil
}

func runTestBinary(t *testing.T, input io.Reader, arguments ...string) string {
	t.Helper()
	command := exec.Command(shellTestBinary, arguments...)
	command.Stdin = input
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("%v failed: %v: %s", arguments, err, output)
	}
	return string(output)
}

func requireOpenSSH(t *testing.T, binary string) {
	t.Helper()
	if _, err := exec.LookPath(binary); err != nil {
		t.Skipf("OpenSSH %s client is unavailable: %v", binary, err)
	}
}

func shellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "'\\''") + "'"
}
