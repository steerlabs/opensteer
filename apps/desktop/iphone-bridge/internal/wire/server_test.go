package wire

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"os"
	"reflect"
	"sync"
	"testing"
	"time"
)

type blockingHandler struct {
	started chan struct{}
	stopped chan struct{}
	once    sync.Once
}

func (h *blockingHandler) Call(ctx context.Context, _ Request) (interface{}, error) {
	h.once.Do(func() { close(h.started) })
	<-ctx.Done()
	close(h.stopped)
	return nil, errors.New("SENTINEL_UDID_KEY_TYPED_SECRET")
}
func (h *blockingHandler) Close() error { return nil }
func fixtureRequest(id uint64, method string, params string) Request {
	return Request{"request", 1, id, 1000, method, json.RawMessage(params)}
}
func TestServerCancellationAndEOF(t *testing.T) {
	for _, cancelRequest := range []bool{false, true} {
		t.Run(map[bool]string{false: "EOF", true: "cancel"}[cancelRequest], func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			client, server := net.Pipe()
			defer client.Close()
			_ = client.SetDeadline(time.Now().Add(time.Second))
			h := &blockingHandler{started: make(chan struct{}), stopped: make(chan struct{})}
			s := &Server{Handler: h, BootID: "fixture"}
			done := make(chan error, 1)
			go func() { done <- s.Run(ctx, server, server) }()
			if err := WriteFrame(client, fixtureRequest(1, "hello", "{}"), MaxRequestBytes); err != nil {
				t.Fatal(err)
			}
			if _, err := ReadFrame(client, MaxResponseBytes); err != nil {
				t.Fatal(err)
			}
			if err := WriteFrame(client, fixtureRequest(2, "roster.get", "{}"), MaxRequestBytes); err != nil {
				t.Fatal(err)
			}
			select {
			case <-h.started:
			case <-ctx.Done():
				t.Fatal("handler never started")
			}
			if cancelRequest {
				if err := WriteFrame(client, fixtureRequest(3, "request.cancel", `{"requestId":2}`), MaxRequestBytes); err != nil {
					t.Fatal(err)
				}
				for range 2 {
					b, err := ReadFrame(client, MaxResponseBytes)
					if err != nil {
						t.Fatal(err)
					}
					if bytesContainSentinel(b) {
						t.Fatal("private error escaped")
					}
				}
			}
			client.Close()
			select {
			case <-h.stopped:
			case <-ctx.Done():
				t.Fatal("EOF/cancel did not cancel native work")
			}
			select {
			case <-done:
			case <-ctx.Done():
				t.Fatal("server did not close")
			}
		})
	}
}
func bytesContainSentinel(b []byte) bool {
	for i := 0; i+8 <= len(b); i++ {
		if string(b[i:i+8]) == "SENTINEL" {
			return true
		}
	}
	return false
}
func TestHandshakeAndIDs(t *testing.T) {
	for _, requests := range [][]Request{
		{fixtureRequest(1, "roster.get", "{}")},
		{fixtureRequest(1, "hello", "{}"), fixtureRequest(1, "roster.get", "{}")},
		{fixtureRequest(1, "hello", "{}"), fixtureRequest(2, "hello", "{}")},
	} {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		c, s := net.Pipe()
		_ = c.SetDeadline(time.Now().Add(time.Second))
		h := &blockingHandler{}
		done := make(chan error, 1)
		go func() { done <- (&Server{Handler: h, BootID: "fixture"}).Run(ctx, s, s) }()
		for i, r := range requests {
			_ = WriteFrame(c, r, MaxRequestBytes)
			if i == 0 && r.Method == "hello" {
				_, _ = ReadFrame(c, MaxResponseBytes)
			}
		}
		select {
		case err := <-done:
			if !errors.Is(err, ErrProtocol) {
				t.Fatalf("got %v", err)
			}
		case <-ctx.Done():
			t.Fatal("invalid request did not close pipe")
		}
		c.Close()
		cancel()
	}
}
func TestEventCoalescing(t *testing.T) {
	s := &Server{BootID: "fixture", eventReady: make(chan struct{}, 1)}
	for revision := uint64(1); revision <= 100; revision++ {
		s.Publish(Roster{Revision: revision, Candidates: []Candidate{}})
	}
	<-s.eventReady
	e := s.nextEvent()
	if e.Sequence != 1 || e.Roster.Revision != 100 || len(s.events) != 0 {
		t.Fatalf("not bounded/latest: %+v", e)
	}
}
func TestGoldenRequests(t *testing.T) {
	data, err := os.ReadFile("../../testdata/ipc-golden.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixtures []json.RawMessage
	if err := json.Unmarshal(data, &fixtures); err != nil {
		t.Fatal(err)
	}
	reason := NotInitialized
	expected := []interface{}{
		fixtureRequest(1, "hello", "{}"),
		Response{"response", 1, HelloResult("fixture-boot")},
		Request{"request", 1, 2, 30000, "setup.inspect", json.RawMessage(`{"localPhoneId":"fixture-phone","nativeEpoch":2}`)},
		Response{"response", 2, ErrorResult{Fail(TrustRequired)}},
		Event{Kind: "event", BootID: "fixture-boot", Sequence: 1, Event: "roster.changed", Roster: &Roster{1, []Candidate{{Trust: "checking", LocalPhoneID: "fixture-phone", NativeEpoch: 2, Name: "Test iPhone 한글", Model: "iPhoneFixture", OSVersion: "27.0", Build: "TEST", Transport: "usb", Capabilities: &Capabilities{Observe: &reason, Act: &reason, Launch: &reason, InstalledApps: &reason, Text: reasonRef(UnsupportedText), Clear: reasonRef(UnsupportedClear), IndexedTargets: reasonRef(GeometryUnavailable), LiveVideo: reasonRef(Unsupported), Wake: &reason}}}}},
	}
	if len(fixtures) != len(expected) {
		t.Fatal("golden count changed")
	}
	for i, b := range fixtures {
		encoded, err := json.Marshal(expected[i])
		if err != nil {
			t.Fatal(err)
		}
		var golden, actual interface{}
		if json.Unmarshal(b, &golden) != nil || json.Unmarshal(encoded, &actual) != nil {
			t.Fatal("invalid golden JSON")
		}
		if !reflect.DeepEqual(golden, actual) {
			t.Fatalf("Go/TS fixture %d differs: %s", i, encoded)
		}
		if request, ok := expected[i].(Request); ok {
			if _, err := DecodeRequest(encoded); err != nil {
				t.Fatalf("request %s: %v", request.Method, err)
			}
		}
	}
}

type countingHandler struct {
	started chan struct{}
	done    chan struct{}
	once    sync.Once
}

func (h *countingHandler) Call(ctx context.Context, _ Request) (interface{}, error) {
	h.started <- struct{}{}
	<-ctx.Done()
	return nil, ctx.Err()
}
func (h *countingHandler) Close() error { h.once.Do(func() { close(h.done) }); return nil }
func TestPendingQueueBound(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	c, s := net.Pipe()
	defer c.Close()
	_ = c.SetDeadline(time.Now().Add(time.Second))
	h := &countingHandler{started: make(chan struct{}, MaxPending), done: make(chan struct{})}
	server := &Server{Handler: h, BootID: "fixture"}
	done := make(chan error, 1)
	go func() { done <- server.Run(ctx, s, s) }()
	_ = WriteFrame(c, fixtureRequest(1, "hello", "{}"), MaxRequestBytes)
	if _, err := ReadFrame(c, MaxResponseBytes); err != nil {
		t.Fatal(err)
	}
	for id := uint64(2); id <= MaxPending+2; id++ {
		if err := WriteFrame(c, fixtureRequest(id, "roster.get", "{}"), MaxRequestBytes); err != nil {
			t.Fatal(err)
		}
	}
	select {
	case err := <-done:
		if !errors.Is(err, ErrProtocol) {
			t.Fatalf("queue overflow: %v", err)
		}
	case <-ctx.Done():
		t.Fatal("pending queue grew without bound")
	}
}

func TestShutdownCancelsWork(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	c, s := net.Pipe()
	defer c.Close()
	_ = c.SetDeadline(time.Now().Add(time.Second))
	h := &blockingHandler{started: make(chan struct{}), stopped: make(chan struct{})}
	done := make(chan error, 1)
	go func() { done <- (&Server{Handler: h, BootID: "fixture"}).Run(ctx, s, s) }()
	_ = WriteFrame(c, fixtureRequest(1, "hello", "{}"), MaxRequestBytes)
	if _, err := ReadFrame(c, MaxResponseBytes); err != nil {
		t.Fatal(err)
	}
	_ = WriteFrame(c, fixtureRequest(2, "roster.get", "{}"), MaxRequestBytes)
	select {
	case <-h.started:
	case <-ctx.Done():
		t.Fatal("work never started")
	}
	_ = WriteFrame(c, fixtureRequest(3, "shutdown", "{}"), MaxRequestBytes)
	for {
		b, err := ReadFrame(c, MaxResponseBytes)
		if err != nil {
			t.Fatal(err)
		}
		var r Response
		if err := json.Unmarshal(b, &r); err != nil {
			t.Fatal(err)
		}
		if r.ID == 3 {
			break
		}
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-ctx.Done():
		t.Fatal("shutdown did not settle")
	}
	select {
	case <-h.stopped:
	default:
		t.Fatal("shutdown left work active")
	}
}

func reasonRef(r Reason) *Reason { return &r }
