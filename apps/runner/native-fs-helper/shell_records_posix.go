//go:build linux || darwin

package main

import (
	"encoding/json"
	"errors"
	"os"
	"sync"
	"sync/atomic"
	"time"

	"golang.org/x/sys/unix"
)

const (
	maxShellAuditCommandPreviewBytes = 1024
	maxShellRecordBytes              = 8 * 1024
	shellAuditQueueSize              = 256
)

type shellLifecycleMessage struct {
	content []byte
	done    chan error
}

type shellRecordEmitter struct {
	audits     chan []byte
	closed     chan struct{}
	dropped    atomic.Uint64
	fd         int
	file       *os.File
	lifecycles chan shellLifecycleMessage
	once       sync.Once
	wg         sync.WaitGroup
}

func newShellRecordEmitter(file *os.File) (*shellRecordEmitter, error) {
	fd := int(file.Fd())
	if err := unix.SetNonblock(fd, true); err != nil {
		return nil, err
	}
	emitter := &shellRecordEmitter{
		audits:     make(chan []byte, shellAuditQueueSize),
		closed:     make(chan struct{}),
		fd:         fd,
		file:       file,
		lifecycles: make(chan shellLifecycleMessage, 2*maxShellChannels+8),
	}
	emitter.wg.Add(1)
	go emitter.writeLoop()
	return emitter, nil
}

func (emitter *shellRecordEmitter) lifecycle(record map[string]any) error {
	content, err := marshalShellRecord(record)
	if err != nil {
		return err
	}
	message := shellLifecycleMessage{content: content, done: make(chan error, 1)}
	select {
	case emitter.lifecycles <- message:
		return <-message.done
	case <-emitter.closed:
		return os.ErrClosed
	}
}

func boundedShellExecAudit(channel uint32, command string) map[string]any {
	record := map[string]any{"kind": "exec", "channel": channel, "command": command}
	if len(command) <= maxShellAuditCommandPreviewBytes {
		return record
	}

	record["commandTruncated"] = true
	boundaries := make([]int, 0, maxShellAuditCommandPreviewBytes+1)
	for index := range command {
		if index > maxShellAuditCommandPreviewBytes {
			break
		}
		boundaries = append(boundaries, index)
	}
	low, high, best := 0, len(boundaries)-1, 0
	for low <= high {
		middle := low + (high-low)/2
		record["command"] = command[:boundaries[middle]]
		if _, err := marshalShellRecord(record); err == nil {
			best = middle
			low = middle + 1
		} else {
			high = middle - 1
		}
	}
	record["command"] = command[:boundaries[best]]
	return record
}

func (emitter *shellRecordEmitter) audit(record map[string]any) {
	content, err := marshalShellRecord(record)
	if err != nil {
		emitter.dropped.Add(1)
		return
	}
	select {
	case emitter.audits <- content:
	default:
		emitter.dropped.Add(1)
	}
}

func marshalShellRecord(record map[string]any) ([]byte, error) {
	content, err := json.Marshal(record)
	if err != nil {
		return nil, err
	}
	content = append(content, '\n')
	if len(content) > maxShellRecordBytes {
		return nil, errors.New("shell record exceeds 8 KiB")
	}
	return content, nil
}

func (emitter *shellRecordEmitter) writeLoop() {
	defer emitter.wg.Done()
	for {
		select {
		case message := <-emitter.lifecycles:
			message.done <- emitter.writeRecord(message.content, true)
			continue
		default:
		}
		if count := emitter.dropped.Swap(0); count > 0 {
			content, _ := marshalShellRecord(map[string]any{"kind": "audit.dropped", "count": count})
			_ = emitter.writeRecord(content, true)
			continue
		}
		select {
		case message := <-emitter.lifecycles:
			message.done <- emitter.writeRecord(message.content, true)
		case content := <-emitter.audits:
			if err := emitter.writeRecord(content, false); errors.Is(err, errShellRecordDropped) {
				emitter.dropped.Add(1)
			}
		case <-emitter.closed:
			emitter.drainRecords()
			return
		}
	}
}

var errShellRecordDropped = errors.New("shell audit record dropped")

func (emitter *shellRecordEmitter) writeRecord(content []byte, lifecycle bool) error {
	written := 0
	for written < len(content) {
		count, err := unix.Write(emitter.fd, content[written:])
		if count > 0 {
			written += count
		}
		if err == nil {
			if count == 0 {
				if !lifecycle && written == 0 {
					return errShellRecordDropped
				}
				time.Sleep(2 * time.Millisecond)
			}
			continue
		}
		if errors.Is(err, unix.EINTR) {
			continue
		}
		if errors.Is(err, unix.EAGAIN) || errors.Is(err, unix.EWOULDBLOCK) {
			if !lifecycle && written == 0 {
				return errShellRecordDropped
			}
			time.Sleep(2 * time.Millisecond)
			continue
		}
		return err
	}
	return nil
}

func (emitter *shellRecordEmitter) drainRecords() {
	for {
		select {
		case message := <-emitter.lifecycles:
			message.done <- emitter.writeRecord(message.content, true)
		default:
			goto audits
		}
	}

audits:
	if count := emitter.dropped.Swap(0); count > 0 {
		content, _ := marshalShellRecord(map[string]any{"kind": "audit.dropped", "count": count})
		_ = emitter.writeRecord(content, true)
	}
	for {
		select {
		case content := <-emitter.audits:
			if err := emitter.writeRecord(content, false); errors.Is(err, errShellRecordDropped) {
				emitter.dropped.Add(1)
			}
		default:
			if count := emitter.dropped.Swap(0); count > 0 {
				content, _ := marshalShellRecord(map[string]any{"kind": "audit.dropped", "count": count})
				_ = emitter.writeRecord(content, true)
			}
			return
		}
	}
}

func (emitter *shellRecordEmitter) close() {
	emitter.once.Do(func() {
		close(emitter.closed)
		emitter.wg.Wait()
		_ = emitter.file.Close()
	})
}
