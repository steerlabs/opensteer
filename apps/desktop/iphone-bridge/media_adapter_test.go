package main

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"

	"github.com/danielpaulus/go-ios/ios/display"
	"github.com/google/uuid"
)

type fakeDisplayClient struct {
	closed    atomic.Bool
	failStop  bool
	stopCalls atomic.Int32
}

func (f *fakeDisplayClient) StartAudioStreamWithOffer(ctx context.Context, req display.AudioStreamRequest, _ []byte) (uuid.UUID, map[string]interface{}, error) {
	if f.closed.Load() {
		return uuid.Nil, nil, errors.New("connection closed")
	}
	return req.ClientSessionID, map[string]interface{}{}, nil
}

func (f *fakeDisplayClient) StartVideoStreamWithOffer(ctx context.Context, req display.VideoStreamRequest, _ []byte) (uuid.UUID, map[string]interface{}, error) {
	if f.closed.Load() {
		return uuid.Nil, nil, errors.New("connection closed")
	}
	return req.ClientSessionID, map[string]interface{}{}, nil
}

func (f *fakeDisplayClient) StopMediaStreamScoped(ctx context.Context, _ uuid.UUID, _ bool) error {
	f.stopCalls.Add(1)
	if f.closed.Load() || f.failStop {
		return errors.New("connection closed")
	}
	return nil
}

func (f *fakeDisplayClient) Close() error {
	f.closed.Store(true)
	return nil
}

func TestSessionDisplayServiceSurvivesStartupContextCancel(t *testing.T) {
	life, cancelLife := context.WithCancel(context.Background())
	defer cancelLife()

	var opens atomic.Int32
	var clients []*fakeDisplayClient
	svc := &sessionDisplayService{
		life: life,
		open: func(connCtx context.Context) (displayServiceClient, error) {
			opens.Add(1)
			c := &fakeDisplayClient{}
			// Mirror Userspace.DialTCP binding socket lifetime to the dial context.
			context.AfterFunc(connCtx, func() { _ = c.Close() })
			clients = append(clients, c)
			return c, nil
		},
	}

	// Pipeline.Start cancels its temporary negotiation context right after openStream succeeds.
	startCtx, cancelStart := context.WithCancel(life)
	id := uuid.New()
	if _, _, err := svc.StartVideoStreamWithOffer(startCtx, display.VideoStreamRequest{ClientSessionID: id}, []byte("offer")); err != nil {
		t.Fatal(err)
	}
	cancelStart()

	if clients[0].closed.Load() {
		t.Fatal("canceling startup negotiation context closed the cached display XPC connection")
	}
	if err := svc.StopMediaStreamScoped(context.Background(), id, false); err != nil {
		t.Fatalf("scoped stop failed after startup context canceled: %v", err)
	}
	if opens.Load() != 1 || clients[0].stopCalls.Load() != 1 {
		t.Fatalf("expected 1 open and 1 stop call, got opens=%d stops=%d", opens.Load(), clients[0].stopCalls.Load())
	}
}

func TestSessionDisplayServiceRetriesScopedStopOnStaleConnection(t *testing.T) {
	life, cancelLife := context.WithCancel(context.Background())
	defer cancelLife()

	var opens atomic.Int32
	var first *fakeDisplayClient
	svc := &sessionDisplayService{
		life: life,
		open: func(connCtx context.Context) (displayServiceClient, error) {
			n := opens.Add(1)
			c := &fakeDisplayClient{}
			if n == 1 {
				first = c
			}
			context.AfterFunc(connCtx, func() { _ = c.Close() })
			return c, nil
		},
	}

	id := uuid.New()
	if _, _, err := svc.StartVideoStreamWithOffer(context.Background(), display.VideoStreamRequest{ClientSessionID: id}, []byte("offer")); err != nil {
		t.Fatal(err)
	}
	// Simulate the iPhone closing an idle displayservice XPC connection before privacy hide.
	first.failStop = true

	if err := svc.StopMediaStreamScoped(context.Background(), id, false); err != nil {
		t.Fatalf("scoped stop did not retry on fresh connection: %v", err)
	}
	if opens.Load() != 2 {
		t.Fatalf("expected fresh connection retry (2 opens), got %d", opens.Load())
	}
}
