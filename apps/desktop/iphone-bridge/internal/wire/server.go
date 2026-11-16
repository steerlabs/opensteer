package wire

import (
	"context"
	"errors"
	"io"
	"sync"
	"time"
)

type Handler interface {
	Call(context.Context, Request) (interface{}, error)
	Close() error
}
type outgoing struct {
	value interface{}
	limit uint32
	ack   chan error
}
type Server struct {
	Handler   Handler
	BootID    string
	mu        sync.Mutex
	pending   map[uint64]context.CancelFunc
	responses chan outgoing
	events    chan Event
	sequence  uint64
}

func (s *Server) Publish(roster Roster) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.events == nil {
		return
	}
	s.sequence++
	event := Event{"event", s.BootID, s.sequence, "roster.changed", roster}
	select {
	case s.events <- event:
	default:
		select {
		case <-s.events:
		default:
		}
		select {
		case s.events <- event:
		default:
		}
	}
}
func (s *Server) Run(parent context.Context, input io.ReadCloser, output io.WriteCloser) error {
	ctx, cancel := context.WithCancel(parent)
	s.pending = make(map[uint64]context.CancelFunc)
	s.responses = make(chan outgoing, MaxPending)
	s.events = make(chan Event, 1)
	var work sync.WaitGroup
	var pumps sync.WaitGroup
	defer func() {
		cancel()
		_ = input.Close()
		_ = output.Close()
		s.mu.Lock()
		for _, f := range s.pending {
			f()
		}
		s.mu.Unlock()
		_ = s.Handler.Close()
		work.Wait()
		pumps.Wait()
	}()
	stop := context.AfterFunc(ctx, func() { _ = input.Close(); _ = output.Close() })
	defer stop()
	writerDone := make(chan error, 1)
	pumps.Add(2)
	go func() {
		defer pumps.Done()
		for {
			var out outgoing
			select {
			case <-ctx.Done():
				writerDone <- ctx.Err()
				return
			case out = <-s.responses:
			default:
				select {
				case <-ctx.Done():
					writerDone <- ctx.Err()
					return
				case out = <-s.responses:
				case event := <-s.events:
					out = outgoing{event, MaxEventBytes, nil}
				}
			}
			err := WriteFrame(output, out.value, out.limit)
			if out.ack != nil {
				out.ack <- err
			}
			if err != nil {
				writerDone <- err
				cancel()
				return
			}
		}
	}()
	type frame struct {
		body     []byte
		err      error
		received time.Time
	}
	incoming := make(chan frame)
	go func() {
		defer pumps.Done()
		for {
			b, err := ReadFrame(input, MaxRequestBytes)
			f := frame{b, err, time.Now()}
			select {
			case incoming <- f:
			case <-ctx.Done():
				return
			}
			if err != nil {
				return
			}
		}
	}()
	var lastID uint64
	hello := false
	send := func(r Response) bool {
		select {
		case s.responses <- outgoing{r, MaxResponseBytes, nil}:
			return true
		default:
			cancel()
			return false
		}
	}
	for {
		select {
		case err := <-writerDone:
			return err
		case <-ctx.Done():
			return ctx.Err()
		case f := <-incoming:
			if f.err != nil {
				if errors.Is(f.err, io.EOF) {
					return nil
				}
				return ErrProtocol
			}
			r, err := DecodeRequest(f.body)
			if err != nil || r.ID <= lastID {
				return ErrProtocol
			}
			lastID = r.ID
			if !hello {
				if r.Method != "hello" {
					return ErrProtocol
				}
				hello = true
				if !send(Response{"response", r.ID, HelloResult(s.BootID)}) {
					return ErrProtocol
				}
				continue
			}
			if r.Method == "hello" {
				return ErrProtocol
			}
			if r.Method == "shutdown" {
				s.mu.Lock()
				for _, abort := range s.pending {
					abort()
				}
				s.mu.Unlock()
				_ = s.Handler.Close()
				ack := make(chan error, 1)
				select {
				case s.responses <- outgoing{Response{"response", r.ID, Empty{}}, MaxResponseBytes, ack}:
				case <-ctx.Done():
					return ctx.Err()
				}
				select {
				case err := <-ack:
					return err
				case <-ctx.Done():
					return ctx.Err()
				}
			}
			if r.Method == "request.cancel" {
				p, _ := Params(r)
				s.mu.Lock()
				abort := s.pending[p.(*CancelParams).RequestID]
				s.mu.Unlock()
				if abort != nil {
					abort()
				}
				if !send(Response{"response", r.ID, Empty{}}) {
					return ErrProtocol
				}
				continue
			}
			s.mu.Lock()
			if len(s.pending) >= MaxPending {
				s.mu.Unlock()
				return ErrProtocol
			}
			callCtx, abort := context.WithDeadline(ctx, f.received.Add(time.Duration(r.TimeoutMs)*time.Millisecond))
			s.pending[r.ID] = abort
			s.mu.Unlock()
			work.Add(1)
			go func() {
				defer work.Done()
				defer func() {
					if recover() != nil {
						cancel()
					}
				}()
				defer abort()
				result, err := s.Handler.Call(callCtx, r)
				if err != nil {
					var failure *Failure
					if !errors.As(err, &failure) {
						failure = Fail(NativeServiceFailed)
					}
					if callCtx.Err() != nil {
						code := Cancelled
						if errors.Is(callCtx.Err(), context.DeadlineExceeded) {
							code = DeadlineExceeded
						}
						failure = &Failure{code, failure.Effect, failure.CompletedSteps}
					}
					result = ErrorResult{failure}
				}
				if callCtx.Err() != nil && err == nil {
					code := Cancelled
					if errors.Is(callCtx.Err(), context.DeadlineExceeded) {
						code = DeadlineExceeded
					}
					result = ErrorResult{Fail(code)}
				}
				s.mu.Lock()
				delete(s.pending, r.ID)
				s.mu.Unlock()
				send(Response{"response", r.ID, result})
			}()
		}
	}
}
