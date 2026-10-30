//go:build linux || darwin

package main

import (
	"encoding/json"
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
