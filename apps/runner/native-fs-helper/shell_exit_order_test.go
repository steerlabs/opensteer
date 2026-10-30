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

func TestShellClosedChannelReleasesSlotBeforeProcessSweep(t *testing.T) {
	fixture := newShellSSHFixture(t, shellPolicy{Reach: "deployment", Commands: true})
	client, closeClient := fixture.goSSHClient(t)
	defer closeClient()
	channel, requests, err := client.OpenChannel("session", nil)
	if err != nil {
		t.Fatal(err)
	}
	accepted, err := channel.SendRequest("exec", true, ssh.Marshal(struct{ Command string }{"trap '' TERM; sleep 30 </dev/null >/dev/null 2>&1 &"}))
	if err != nil || !accepted {
		t.Fatalf("exec accepted=%t error=%v", accepted, err)
	}
	request := <-requests
	if request == nil || request.Type != "exit-status" {
		t.Fatalf("expected exit status, got %v", request)
	}
	_ = channel.Close()
	for range requests {
	}
	channels := make([]ssh.Channel, 0, maxShellChannels)
	streams := make([]<-chan *ssh.Request, 0, maxShellChannels)
	for index := 0; index < maxShellChannels; index++ {
		opened, stream, err := client.OpenChannel("session", nil)
		if err != nil {
			t.Fatalf("open channel %d after close: %v", index, err)
		}
		channels = append(channels, opened)
		streams = append(streams, stream)
	}
	for _, opened := range channels {
		_ = opened.Close()
	}
	for _, stream := range streams {
		for range stream {
		}
	}
	for index := 0; index < maxShellChannels+1; index++ {
		opened, stream, err := client.OpenChannel("session", nil)
		if err != nil {
			t.Fatalf("reopen channel %d: %v", index, err)
		}
		_ = opened.Close()
		for range stream {
		}
	}
}
