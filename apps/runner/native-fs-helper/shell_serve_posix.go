//go:build linux || darwin

package main

import (
	"bufio"
	"bytes"
	"context"
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
	"path"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
	"unicode/utf8"

	"golang.org/x/crypto/ssh"
)

const (
	maxShellInitBytes = 256 * 1024
	maxShellPathBytes = 1024
	maxShellChannels  = 64
	defaultIdleTime   = 30 * time.Minute
	processKillDelay  = 5 * time.Second
	shellCleanupGrace = 2 * time.Second
)

type shellAuthority struct {
	CallerMachineName string `json:"callerMachineName"`
	PolicyRevision    int64  `json:"policyRevision"`
	RequestedBy       string `json:"requestedBy"`
	RunID             string `json:"runId"`
	SessionID         string `json:"sessionId"`
	StartedAt         string `json:"startedAt"`
	ThreadID          string `json:"threadId"`
	ThreadTitle       string `json:"threadTitle"`
	WorkspaceID       string `json:"workspaceId"`
}

type shellSharePolicy struct {
	Mode string `json:"mode"`
	Path string `json:"path"`
}

type shellPolicy struct {
	Commands   bool               `json:"commands"`
	Forwarding bool               `json:"forwarding"`
	Reach      string             `json:"reach"`
	Shares     []shellSharePolicy `json:"shares"`
}

type shellInit struct {
	Authority   shellAuthority `json:"authority"`
	HostKeyPath string         `json:"hostKeyPath"`
	IdleTimeout *int64         `json:"idleTimeoutMs,omitempty"`
	MachineName string         `json:"machineName"`
	Policy      shellPolicy    `json:"policy"`
}

type trackedShellProcess struct {
	channel       uint32
	channelClosed atomic.Bool
	cmd           *exec.Cmd
	done          chan struct{}
	sweepDone     chan struct{}
	pgid          int
}

type trackedShellForward struct {
	cancel     context.CancelFunc
	connection net.Conn
}

type shellSession struct {
	authority   shellAuthority
	channelWG   sync.WaitGroup
	channelSeq  atomic.Uint32
	channels    atomic.Int32
	cleanup     sync.Once
	closing     atomic.Bool
	connMu      sync.Mutex
	connection  io.Closer
	cleanupDone chan struct{}
	emitter     *shellRecordEmitter
	forwardMu   sync.Mutex
	forwards    map[*trackedShellForward]struct{}
	home        string
	idle        *shellIdleClock
	machine     string
	policy      shellPolicy
	processMu   sync.Mutex
	processes   map[int]*trackedShellProcess
	shares      []*shellShare
}

func runShellServe(input io.Reader, output io.Writer) error {
	buffered, init, signer, err := readShellInit(input)
	if err != nil {
		return err
	}
	account, err := user.Current()
	if err != nil || account.HomeDir == "" {
		return errors.New("determine shell account home directory")
	}
	recordFile := os.NewFile(3, "opensteer-shell-records")
	if recordFile == nil {
		return errors.New("open shell lifecycle descriptor 3")
	}
	emitter, err := newShellRecordEmitter(recordFile)
	if err != nil {
		return err
	}
	idleTimeout := defaultIdleTime
	if init.IdleTimeout != nil {
		idleTimeout = time.Duration(*init.IdleTimeout) * time.Millisecond
	}
	session := &shellSession{
		authority:   init.Authority,
		emitter:     emitter,
		cleanupDone: make(chan struct{}),
		forwards:    make(map[*trackedShellForward]struct{}),
		home:        account.HomeDir,
		idle:        newShellIdleClock(idleTimeout),
		machine:     init.MachineName,
		policy:      init.Policy,
		processes:   make(map[int]*trackedShellProcess),
	}
	defer func() {
		session.cleanupSession()
		session.closeShares()
		emitter.close()
	}()
	session.shares = openShellShares(init.Policy.Shares, emitter)

	transport := &shellStdioConn{reader: buffered, writer: output}
	if closer, ok := input.(io.Closer); ok {
		transport.closer = closer
	}
	if closer, ok := output.(io.Closer); ok {
		transport.outputCloser = closer
	}
	session.setConnection(transport)
	config := &ssh.ServerConfig{
		NoClientAuth:  true,
		ServerVersion: "SSH-2.0-Opensteer",
	}
	config.AddHostKey(signer)
	if err := emitter.lifecycle(map[string]any{"kind": "ready"}); err != nil {
		return err
	}

	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGTERM)
	defer signal.Stop(signals)
	go func() {
		select {
		case <-signals:
			session.cleanupSession()
		case <-session.idle.done:
		}
	}()
	go session.watchIdle()

	serverConnection, channels, requests, err := ssh.NewServerConn(transport, config)
	if err != nil {
		return nil
	}
	session.setConnection(serverConnection)
	go session.handleGlobalRequests(requests)
	for channel := range channels {
		if session.closing.Load() {
			_ = channel.Reject(ssh.ConnectionFailed, "Opensteer is closing this session.")
			continue
		}
		session.idle.touch()
		channelID := session.nextChannel()
		if session.channels.Add(1) > maxShellChannels {
			session.channels.Add(-1)
			session.denied(&channelID, "subsystem", "The session already has 64 open channels.")
			_ = channel.Reject(ssh.ResourceShortage, "The session already has 64 open channels.")
			continue
		}
		session.channelWG.Add(1)
		go func() {
			defer session.channelWG.Done()
			defer session.channels.Add(-1)
			session.handleChannel(channelID, channel)
		}()
	}
	_ = serverConnection.Wait()
	session.cleanupSession()
	session.channelWG.Wait()
	return nil
}

func readShellInit(input io.Reader) (*bufio.Reader, shellInit, ssh.Signer, error) {
	reader := bufio.NewReaderSize(input, 64*1024)
	var lengthBytes [4]byte
	if _, err := io.ReadFull(reader, lengthBytes[:]); err != nil {
		return nil, shellInit{}, nil, fmt.Errorf("read shell init length: %w", err)
	}
	length := binary.BigEndian.Uint32(lengthBytes[:])
	if length == 0 || length > maxShellInitBytes {
		return nil, shellInit{}, nil, errors.New("shell init frame must be between 1 byte and 256 KiB")
	}
	content := make([]byte, length)
	if _, err := io.ReadFull(reader, content); err != nil {
		return nil, shellInit{}, nil, fmt.Errorf("read shell init frame: %w", err)
	}
	if !utf8.Valid(content) || !shellInitHasRequiredFields(content) {
		return nil, shellInit{}, nil, errors.New("shell init frame is invalid JSON")
	}
	decoder := json.NewDecoder(strings.NewReader(string(content)))
	decoder.DisallowUnknownFields()
	var init shellInit
	if err := decoder.Decode(&init); err != nil || decoder.Decode(&struct{}{}) != io.EOF {
		return nil, shellInit{}, nil, errors.New("shell init frame is invalid JSON")
	}
	if err := validateShellInit(init); err != nil {
		return nil, shellInit{}, nil, err
	}
	signer, err := loadShellHostKey(init.HostKeyPath)
	if err != nil {
		return nil, shellInit{}, nil, fmt.Errorf("load shell host key: %w", err)
	}
	if signer.PublicKey().Type() != ssh.KeyAlgoED25519 {
		return nil, shellInit{}, nil, errors.New("shell host key is not Ed25519")
	}
	return reader, init, signer, nil
}

func shellInitHasRequiredFields(content []byte) bool {
	var top map[string]json.RawMessage
	if json.Unmarshal(content, &top) != nil || !hasJSONFields(top, "authority", "hostKeyPath", "machineName", "policy") {
		return false
	}
	if idle, ok := top["idleTimeoutMs"]; ok && bytes.Equal(bytes.TrimSpace(idle), []byte("null")) {
		return false
	}
	var authority map[string]json.RawMessage
	if json.Unmarshal(top["authority"], &authority) != nil || !hasJSONFields(authority,
		"callerMachineName", "policyRevision", "requestedBy", "runId", "sessionId", "startedAt", "threadId", "threadTitle", "workspaceId") {
		return false
	}
	var policy map[string]json.RawMessage
	return json.Unmarshal(top["policy"], &policy) == nil && hasJSONFields(policy, "commands", "forwarding", "reach", "shares")
}

func hasJSONFields(object map[string]json.RawMessage, names ...string) bool {
	for _, name := range names {
		value, ok := object[name]
		if !ok || bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			return false
		}
	}
	return true
}

func validateShellInit(init shellInit) error {
	authority := init.Authority
	if authority.SessionID == "" || authority.RunID == "" || authority.ThreadID == "" || authority.WorkspaceID == "" ||
		authority.RequestedBy == "" || authority.CallerMachineName == "" || authority.StartedAt == "" ||
		utf8.RuneCountInString(authority.ThreadTitle) > 240 || utf8.RuneCountInString(authority.CallerMachineName) > 160 || authority.PolicyRevision < 1 || init.HostKeyPath == "" || strings.ContainsRune(init.HostKeyPath, 0) {
		return errors.New("shell init authority is invalid")
	}
	if init.MachineName == "" || utf8.RuneCountInString(init.MachineName) > 160 {
		return errors.New("shell init machine name is invalid")
	}
	if _, err := time.Parse(time.RFC3339Nano, authority.StartedAt); err != nil {
		return errors.New("shell init authority start time is invalid")
	}
	if init.Policy.Reach != "nobody" && init.Policy.Reach != "owner" && init.Policy.Reach != "deployment" {
		return errors.New("shell init policy reach is invalid")
	}
	if init.Policy.Shares == nil || len(init.Policy.Shares) > 32 {
		return errors.New("shell init policy has too many shares")
	}
	seen := make([]string, 0, len(init.Policy.Shares))
	for _, share := range init.Policy.Shares {
		if share.Path == "/" || !path.IsAbs(share.Path) || path.Clean(share.Path) != share.Path || strings.Contains(share.Path, "//") || strings.ContainsRune(share.Path, 0) || len(share.Path) > maxShellPathBytes || !utf8.ValidString(share.Path) ||
			(share.Mode != "read" && share.Mode != "read-write") {
			return errors.New("shell init policy share is invalid")
		}
		for _, prior := range seen {
			if shellPathWithin(share.Path, prior) || shellPathWithin(prior, share.Path) {
				return errors.New("shell init policy shares overlap")
			}
		}
		seen = append(seen, share.Path)
	}
	if init.IdleTimeout != nil && (*init.IdleTimeout < 1 || *init.IdleTimeout > int64((24*time.Hour)/time.Millisecond)) {
		return errors.New("shell init idle timeout is invalid")
	}
	return nil
}

func shellPathWithin(candidate, root string) bool {
	candidateComponents := shellPathComponents(candidate)
	rootComponents := shellPathComponents(root)
	if len(rootComponents) > len(candidateComponents) {
		return false
	}
	for index, component := range rootComponents {
		if candidateComponents[index] != component {
			return false
		}
	}
	return true
}

func shellPathComponents(value string) []string {
	trimmed := strings.TrimPrefix(value, "/")
	if trimmed == "" {
		return nil
	}
	return strings.Split(trimmed, "/")
}

func (session *shellSession) nextChannel() uint32 {
	return session.channelSeq.Add(1)
}

func (session *shellSession) setConnection(connection io.Closer) {
	session.connMu.Lock()
	session.connection = connection
	session.connMu.Unlock()
}

func (session *shellSession) closeConnection() {
	session.connMu.Lock()
	connection := session.connection
	session.connMu.Unlock()
	if connection != nil {
		_ = connection.Close()
	}
}

func (session *shellSession) handleGlobalRequests(requests <-chan *ssh.Request) {
	for request := range requests {
		if request.Type == "keepalive@openssh.com" {
			if request.WantReply {
				_ = request.Reply(true, nil)
			}
			continue
		}
		session.idle.touch()
		session.denied(nil, "global-request", request.Type)
		if request.WantReply {
			_ = request.Reply(false, nil)
		}
	}
}

func (session *shellSession) handleChannel(channelID uint32, incoming ssh.NewChannel) {
	switch incoming.ChannelType() {
	case "session":
		session.handleSessionChannel(channelID, incoming)
	case "direct-tcpip":
		session.handleForwardChannel(channelID, incoming)
	default:
		session.denied(&channelID, "subsystem", incoming.ChannelType())
		_ = incoming.Reject(ssh.UnknownChannelType, "Opensteer does not support this SSH channel type.")
	}
}

func (session *shellSession) handleSessionChannel(channelID uint32, incoming ssh.NewChannel) {
	channel, requests, err := incoming.Accept()
	if err != nil {
		return
	}
	defer channel.Close()
	for request := range requests {
		session.idle.touch()
		switch request.Type {
		case "exec":
			var payload struct{ Command string }
			if err := ssh.Unmarshal(request.Payload, &payload); err != nil || !utf8.ValidString(payload.Command) {
				session.denied(&channelID, "exec", "Command is invalid or exceeds the audit limit.")
				_ = request.Reply(true, nil)
				session.writeRefusal(channel, "Opensteer refused an invalid command.")
				session.emitter.audit(map[string]any{"kind": "channel.closed", "channel": channelID, "exitStatus": 126})
				session.sendExitStatus(channel, 126)
				return
			}
			if len(payload.Command) > 4096 {
				session.denied(&channelID, "exec", "Command is longer than 4096 bytes.")
				_ = request.Reply(true, nil)
				session.writeRefusal(channel, "Commands longer than 4096 bytes are refused.")
				session.emitter.audit(map[string]any{"kind": "channel.closed", "channel": channelID, "exitStatus": 126})
				session.sendExitStatus(channel, 126)
				return
			}
			if !session.policy.Commands {
				session.denied(&channelID, "exec", "Commands are disabled by this computer's access policy.")
				_ = request.Reply(true, nil)
				session.writeRefusal(channel, fmt.Sprintf("%s does not allow commands from other computers.", session.machine))
				session.emitter.audit(map[string]any{"kind": "channel.closed", "channel": channelID, "exitStatus": 126})
				session.sendExitStatus(channel, 126)
				return
			}
			session.emitter.audit(boundedShellExecAudit(channelID, payload.Command))
			if err := session.runCommand(channelID, channel, requests, request, payload.Command); err != nil {
				session.denied(&channelID, "exec", shortenShellDetail(err.Error()))
				_ = request.Reply(true, nil)
				session.writeRefusal(channel, err.Error())
				session.emitter.audit(map[string]any{"kind": "channel.closed", "channel": channelID, "exitStatus": 126})
				session.sendExitStatus(channel, 126)
			}
			return
		case "subsystem":
			var payload struct{ Name string }
			if err := ssh.Unmarshal(request.Payload, &payload); err != nil || payload.Name != "sftp" {
				detail := "invalid subsystem"
				if payload.Name != "" {
					detail = payload.Name
				}
				session.denied(&channelID, "subsystem", detail)
				_ = request.Reply(false, nil)
				continue
			}
			_ = request.Reply(true, nil)
			exitStatus := uint32(0)
			if err := session.serveSFTP(channelID, channel); err != nil && !errors.Is(err, io.EOF) {
				exitStatus = 1
			}
			session.emitter.audit(map[string]any{"kind": "channel.closed", "channel": channelID, "exitStatus": exitStatus})
			session.sendExitStatus(channel, exitStatus)
			return
		case "pty-req":
			// Refusing the terminal must leave the channel open: OpenSSH reports the
			// refusal and carries on to its exec, so `ssh -t host command` still runs.
			session.denied(&channelID, "pty", request.Type)
			_ = request.Reply(false, nil)
		case "shell":
			// A refused shell request makes OpenSSH discard the channel before any
			// output arrives, so accept it and answer with the sentence and 126.
			session.denied(&channelID, "shell", request.Type)
			_ = request.Reply(true, nil)
			_, _ = io.WriteString(channel.Stderr(), "Opensteer does not provide interactive terminals; run a command.\n")
			session.emitter.audit(map[string]any{"kind": "channel.closed", "channel": channelID, "exitStatus": 126})
			session.sendExitStatus(channel, 126)
			return
		case "env":
			session.denied(&channelID, "env", "Environment changes are not allowed.")
			_ = request.Reply(false, nil)
		case "x11-req", "auth-agent-req@openssh.com":
			session.denied(&channelID, "subsystem", request.Type)
			_ = request.Reply(false, nil)
		default:
			session.denied(&channelID, "subsystem", request.Type)
			_ = request.Reply(false, nil)
		}
	}
}

func (session *shellSession) runCommand(channelID uint32, channel ssh.Channel, requests <-chan *ssh.Request, request *ssh.Request, command string) error {
	shell := os.Getenv("SHELL")
	if shell == "" {
		return errors.New("Opensteer cannot run commands because SHELL is not set.")
	}
	info, err := os.Stat(shell)
	if err != nil || info.IsDir() || info.Mode()&0111 == 0 {
		return fmt.Errorf("Opensteer cannot run commands because SHELL %q is not executable.", shell)
	}
	cmd := exec.Command(shell, "-c", command)
	cmd.Dir = session.home
	cmd.Env = filteredShellEnvironment()
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return fmt.Errorf("Opensteer could not prepare the command: %w", err)
	}
	cmd.Stdout = shellActivityWriter{writer: channel, idle: session.idle}
	cmd.Stderr = shellActivityWriter{writer: channel.Stderr(), idle: session.idle}
	session.processMu.Lock()
	if session.closing.Load() {
		session.processMu.Unlock()
		_ = stdin.Close()
		return errors.New("Opensteer is closing this session.")
	}
	if err := cmd.Start(); err != nil {
		session.processMu.Unlock()
		_ = stdin.Close()
		return fmt.Errorf("Opensteer could not start the command: %w", err)
	}
	process := &trackedShellProcess{channel: channelID, cmd: cmd, done: make(chan struct{}), sweepDone: make(chan struct{}), pgid: cmd.Process.Pid}
	session.processes[process.pgid] = process
	session.processMu.Unlock()
	_ = session.emitter.lifecycle(map[string]any{"kind": "process.started", "channel": channelID, "processGroupId": process.pgid})
	_ = request.Reply(true, nil)

	go func() {
		for next := range requests {
			session.idle.touch()
			session.denied(&channelID, "exec", "Only one exec request is allowed per channel.")
			_ = next.Reply(false, nil)
		}
		process.channelClosed.Store(true)
		if !processDone(process.done) {
			terminateShellProcessGroup(process)
		}
	}()
	inputDone := make(chan struct{})
	go func() {
		_, _ = io.Copy(stdin, shellActivityReader{reader: channel, idle: session.idle})
		_ = stdin.Close()
		close(inputDone)
	}()

	waitErr := cmd.Wait()
	close(process.done)
	status, signalName := shellExitResult(waitErr)
	if !process.channelClosed.Load() {
		if signalName != "" {
			session.sendExitSignal(channel, signalName)
		} else {
			session.sendExitStatus(channel, status)
		}
	}
	// The channel must remain open until the lifecycle writer acknowledges exit.
	session.finishShellProcess(process)
	if process.channelClosed.Load() {
		session.emitter.audit(map[string]any{"kind": "channel.closed", "channel": channelID})
	} else if signalName != "" {
		session.emitter.audit(map[string]any{"kind": "channel.closed", "channel": channelID, "exitSignal": signalName})
	} else {
		session.emitter.audit(map[string]any{"kind": "channel.closed", "channel": channelID, "exitStatus": status})
	}
	return nil
}

func (session *shellSession) finishShellProcess(process *trackedShellProcess) {
	terminateRemainingShellGroup(process.pgid)
	_ = session.emitter.lifecycle(map[string]any{"kind": "process.exited", "channel": process.channel, "processGroupId": process.pgid})
	session.processMu.Lock()
	delete(session.processes, process.pgid)
	session.processMu.Unlock()
	close(process.sweepDone)
}

func processDone(done <-chan struct{}) bool {
	select {
	case <-done:
		return true
	default:
		return false
	}
}

func terminateShellProcessGroup(process *trackedShellProcess) {
	_ = syscall.Kill(-process.pgid, syscall.SIGTERM)
	timer := time.NewTimer(processKillDelay)
	defer timer.Stop()
	select {
	case <-process.done:
		terminateRemainingShellGroup(process.pgid)
	case <-timer.C:
		_ = syscall.Kill(-process.pgid, syscall.SIGKILL)
	}
}

func terminateRemainingShellGroup(processGroupID int) {
	if err := syscall.Kill(-processGroupID, 0); err != nil {
		return
	}
	_ = syscall.Kill(-processGroupID, syscall.SIGTERM)
	deadline := time.Now().Add(processKillDelay)
	for time.Now().Before(deadline) {
		if err := syscall.Kill(-processGroupID, 0); errors.Is(err, syscall.ESRCH) {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	_ = syscall.Kill(-processGroupID, syscall.SIGKILL)
}

func shellExitResult(err error) (uint32, string) {
	if err == nil {
		return 0, ""
	}
	if exit, ok := err.(*exec.ExitError); ok {
		if status, ok := exit.Sys().(syscall.WaitStatus); ok {
			if status.Signaled() {
				return 0, shellSignalName(status.Signal())
			}
			return uint32(status.ExitStatus()), ""
		}
	}
	return 255, ""
}

func shellSignalName(signal syscall.Signal) string {
	names := map[syscall.Signal]string{
		syscall.SIGHUP: "HUP", syscall.SIGINT: "INT", syscall.SIGQUIT: "QUIT", syscall.SIGILL: "ILL",
		syscall.SIGABRT: "ABRT", syscall.SIGFPE: "FPE", syscall.SIGKILL: "KILL", syscall.SIGSEGV: "SEGV",
		syscall.SIGPIPE: "PIPE", syscall.SIGALRM: "ALRM", syscall.SIGTERM: "TERM", syscall.SIGUSR1: "USR1",
		syscall.SIGUSR2: "USR2",
	}
	if name := names[signal]; name != "" {
		return name
	}
	return strings.TrimPrefix(strings.ToUpper(signal.String()), "SIG")
}

func (session *shellSession) sendExitStatus(channel ssh.Channel, status uint32) {
	_, _ = channel.SendRequest("exit-status", false, ssh.Marshal(struct{ Status uint32 }{status}))
}

func (session *shellSession) sendExitSignal(channel ssh.Channel, signalName string) {
	payload := struct {
		Signal     string
		CoreDumped bool
		Message    string
		Language   string
	}{Signal: signalName}
	_, _ = channel.SendRequest("exit-signal", false, ssh.Marshal(payload))
}

func (session *shellSession) writeRefusal(channel ssh.Channel, sentence string) {
	_, _ = io.WriteString(channel.Stderr(), sentence+"\n")
}

func filteredShellEnvironment() []string {
	environment := make([]string, 0, len(os.Environ()))
	for _, value := range os.Environ() {
		name, _, _ := strings.Cut(value, "=")
		if !strings.HasPrefix(name, "OPENSTEER_") {
			environment = append(environment, value)
		}
	}
	return environment
}

func (session *shellSession) handleForwardChannel(channelID uint32, incoming ssh.NewChannel) {
	var request struct {
		Host       string
		Port       uint32
		OriginHost string
		OriginPort uint32
	}
	if err := ssh.Unmarshal(incoming.ExtraData(), &request); err != nil || request.Host == "" || request.Port > 65535 {
		session.denied(&channelID, "forward", "Invalid direct-tcpip request.")
		_ = incoming.Reject(ssh.Prohibited, "Opensteer refused an invalid port-forwarding request.")
		return
	}
	if !session.policy.Forwarding {
		message := fmt.Sprintf("%s does not allow port forwarding from other computers.", session.machine)
		session.denied(&channelID, "forward", message)
		_ = incoming.Reject(ssh.Prohibited, message)
		return
	}
	session.emitter.audit(map[string]any{"kind": "forward", "channel": channelID, "host": request.Host, "port": request.Port})
	forward, dialContext, ok := session.beginForward()
	if !ok {
		_ = incoming.Reject(ssh.ConnectionFailed, "Opensteer is closing this session.")
		return
	}
	defer session.endForward(forward)
	target, err := (&net.Dialer{}).DialContext(dialContext, "tcp", net.JoinHostPort(request.Host, fmt.Sprintf("%d", request.Port)))
	if err != nil {
		_ = incoming.Reject(ssh.ConnectionFailed, shortenShellDetail(err.Error()))
		return
	}
	if !session.attachForwardConnection(forward, target) {
		_ = incoming.Reject(ssh.ConnectionFailed, "Opensteer is closing this session.")
		return
	}
	channel, requests, err := incoming.Accept()
	if err != nil {
		return
	}
	defer channel.Close()
	channelClosed := make(chan struct{})
	go func() {
		ssh.DiscardRequests(requests)
		close(channelClosed)
	}()
	done := make(chan struct{}, 2)
	go func() {
		_, _ = io.Copy(shellActivityWriter{writer: target, idle: session.idle}, shellActivityReader{reader: channel, idle: session.idle})
		if tcp, ok := target.(*net.TCPConn); ok {
			_ = tcp.CloseWrite()
		}
		done <- struct{}{}
	}()
	go func() {
		_, _ = io.Copy(shellActivityWriter{writer: channel, idle: session.idle}, shellActivityReader{reader: target, idle: session.idle})
		_ = channel.CloseWrite()
		done <- struct{}{}
	}()
	cleanupDone := session.cleanupDone
	for completed := 0; completed < 2; {
		select {
		case <-done:
			completed++
		case <-channelClosed:
			session.closeForwardConnection(forward)
			channelClosed = nil
		case <-cleanupDone:
			session.closeForwardConnection(forward)
			cleanupDone = nil
		}
	}
	session.emitter.audit(map[string]any{"kind": "channel.closed", "channel": channelID})
}

func (session *shellSession) beginForward() (*trackedShellForward, context.Context, bool) {
	dialContext, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	forward := &trackedShellForward{cancel: cancel}
	session.forwardMu.Lock()
	defer session.forwardMu.Unlock()
	if session.closing.Load() {
		cancel()
		return nil, nil, false
	}
	session.forwards[forward] = struct{}{}
	return forward, dialContext, true
}

func (session *shellSession) attachForwardConnection(forward *trackedShellForward, connection net.Conn) bool {
	session.forwardMu.Lock()
	defer session.forwardMu.Unlock()
	if session.closing.Load() {
		_ = connection.Close()
		return false
	}
	if _, ok := session.forwards[forward]; !ok {
		_ = connection.Close()
		return false
	}
	forward.connection = connection
	return true
}

func (session *shellSession) closeForwardConnection(forward *trackedShellForward) {
	session.forwardMu.Lock()
	connection := forward.connection
	cancel := forward.cancel
	session.forwardMu.Unlock()
	cancel()
	if connection != nil {
		_ = connection.Close()
	}
}

func (session *shellSession) endForward(forward *trackedShellForward) {
	session.forwardMu.Lock()
	delete(session.forwards, forward)
	connection := forward.connection
	cancel := forward.cancel
	session.forwardMu.Unlock()
	cancel()
	if connection != nil {
		_ = connection.Close()
	}
}

func (session *shellSession) closeForwards() {
	session.forwardMu.Lock()
	forwards := make([]*trackedShellForward, 0, len(session.forwards))
	for forward := range session.forwards {
		forwards = append(forwards, forward)
	}
	session.forwardMu.Unlock()
	for _, forward := range forwards {
		session.closeForwardConnection(forward)
	}
}

func (session *shellSession) denied(channel *uint32, what, detail string) {
	record := map[string]any{"kind": "denied", "what": what, "detail": shortenShellDetail(detail)}
	if channel != nil {
		record["channel"] = *channel
	}
	session.emitter.audit(record)
}

func shortenShellDetail(detail string) string {
	const marker = "…[truncated]"
	if len(detail) <= 512 {
		return detail
	}
	limit := 512 - len(marker)
	for limit > 0 && !utf8.RuneStart(detail[limit]) {
		limit--
	}
	return detail[:limit] + marker
}

func (session *shellSession) watchIdle() {
	if session.idle.wait() {
		_ = session.emitter.lifecycle(map[string]any{"kind": "session.end", "reason": "idle-timeout"})
		session.cleanupSession()
	}
}

func (session *shellSession) cleanupSession() {
	session.cleanup.Do(func() {
		session.processMu.Lock()
		session.closing.Store(true)
		session.processMu.Unlock()
		close(session.cleanupDone)
		session.idle.stop()
		session.closeForwards()
		// A stalled client must not prevent closing the transport indefinitely.
		defer session.closeConnection()
		processes := session.snapshotProcesses()
		for _, process := range processes {
			process.channelClosed.Store(true)
			go terminateShellProcessGroup(process)
		}
		deadline := time.NewTimer(shellCleanupGrace)
		defer deadline.Stop()
		for _, process := range processes {
			select {
			case <-process.sweepDone:
			case <-deadline.C:
				return
			}
		}
	})
}

func (session *shellSession) snapshotProcesses() []*trackedShellProcess {
	session.processMu.Lock()
	defer session.processMu.Unlock()
	processes := make([]*trackedShellProcess, 0, len(session.processes))
	for _, process := range session.processes {
		processes = append(processes, process)
	}
	return processes
}

type shellStdioConn struct {
	closed       atomic.Bool
	closer       io.Closer
	outputCloser io.Closer
	reader       io.Reader
	writer       io.Writer
}

func (connection *shellStdioConn) Read(target []byte) (int, error) {
	return connection.reader.Read(target)
}
func (connection *shellStdioConn) Write(content []byte) (int, error) {
	return connection.writer.Write(content)
}
func (connection *shellStdioConn) Close() error {
	connection.closed.Store(true)
	if connection.outputCloser != nil {
		_ = connection.outputCloser.Close()
	}
	if connection.closer != nil {
		return connection.closer.Close()
	}
	return nil
}
func (connection *shellStdioConn) LocalAddr() net.Addr              { return shellStdioAddr("local") }
func (connection *shellStdioConn) RemoteAddr() net.Addr             { return shellStdioAddr("remote") }
func (connection *shellStdioConn) SetDeadline(time.Time) error      { return nil }
func (connection *shellStdioConn) SetReadDeadline(time.Time) error  { return nil }
func (connection *shellStdioConn) SetWriteDeadline(time.Time) error { return nil }

type shellStdioAddr string

func (address shellStdioAddr) Network() string { return "stdio" }
func (address shellStdioAddr) String() string  { return string(address) }

type shellIdleClock struct {
	done    chan struct{}
	lastMu  sync.Mutex
	last    time.Time
	once    sync.Once
	timeout time.Duration
	wake    chan struct{}
}

func newShellIdleClock(timeout time.Duration) *shellIdleClock {
	return &shellIdleClock{done: make(chan struct{}), last: time.Now(), timeout: timeout, wake: make(chan struct{}, 1)}
}

func (clock *shellIdleClock) touch() {
	clock.lastMu.Lock()
	clock.last = time.Now()
	clock.lastMu.Unlock()
	select {
	case clock.wake <- struct{}{}:
	default:
	}
}

func (clock *shellIdleClock) wait() bool {
	for {
		clock.lastMu.Lock()
		remaining := clock.timeout - time.Since(clock.last)
		clock.lastMu.Unlock()
		if remaining <= 0 {
			return true
		}
		timer := time.NewTimer(remaining)
		select {
		case <-clock.done:
			if !timer.Stop() {
				<-timer.C
			}
			return false
		case <-clock.wake:
			if !timer.Stop() {
				<-timer.C
			}
		case <-timer.C:
		}
	}
}

func (clock *shellIdleClock) stop() { clock.once.Do(func() { close(clock.done) }) }

type shellActivityReader struct {
	idle   *shellIdleClock
	reader io.Reader
}

func (reader shellActivityReader) Read(target []byte) (int, error) {
	count, err := reader.reader.Read(target)
	if count > 0 {
		reader.idle.touch()
	}
	return count, err
}

type shellActivityWriter struct {
	idle   *shellIdleClock
	writer io.Writer
}

func (writer shellActivityWriter) Write(content []byte) (int, error) {
	count, err := writer.writer.Write(content)
	if count > 0 {
		writer.idle.touch()
	}
	return count, err
}
