//go:build linux || darwin

package main

import (
	"encoding/json"
	"time"

	"golang.org/x/crypto/ssh"
	"testing"
)

func TestShellProcessRemainsTrackedUntilExitRecordWritten(t *testing.T) {
	emitter := &shellRecordEmitter{lifecycles: make(chan shellLifecycleMessage), closed: make(chan struct{})}
	process := &trackedShellProcess{channel: 1, pgid: 2147483647, sweepDone: make(chan struct{})}
	session := &shellSession{emitter: emitter, processes: map[int]*trackedShellProcess{process.pgid: process}}
	go session.finishShellProcess(process)
	message := <-emitter.lifecycles
	var record map[string]any
	if err := json.Unmarshal(message.content, &record); err != nil {
		t.Fatal(err)
	}
	session.processMu.Lock()
	_, tracked := session.processes[process.pgid]
	session.processMu.Unlock()
	message.done <- nil
	<-process.sweepDone
	if record["kind"] != "process.exited" {
		t.Fatalf("unexpected lifecycle record: %v", record)
	}
	if !tracked {
		t.Fatal("process removed before exit record was written")
	}
}

func TestShellCleanupUnblocksClientNotReadingOutput(t *testing.T) {
	fixture := newShellSSHFixtureWithIdle(t, shellPolicy{Reach: "deployment", Commands: true}, 100*time.Millisecond)
	client, closeClient := fixture.goSSHClient(t)
	defer closeClient()
	channel, _, err := client.OpenChannel("session", nil)
	if err != nil {
		t.Fatal(err)
	}
	accepted, err := channel.SendRequest("exec", true, ssh.Marshal(struct{ Command string }{"yes"}))
	if err != nil || !accepted {
		t.Fatalf("exec accepted=%t error=%v", accepted, err)
	}
	done := make(chan struct{})
	go func() { _ = client.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(4 * time.Second):
		_ = client.Close()
		<-done
		t.Fatal("cleanup did not close a client that stopped reading")
	}
	closeClient()
}
