package main

import (
	"context"
	"sync"
	"time"

	"github.com/danielpaulus/go-ios/ios/display"
	"github.com/google/uuid"
	"github.com/steerlabs/opensteer/iphone-bridge/internal/media"
	"github.com/steerlabs/opensteer/iphone-bridge/internal/phone"
)

type displayServiceClient interface {
	StartAudioStreamWithOffer(ctx context.Context, req display.AudioStreamRequest, offer []byte) (uuid.UUID, map[string]interface{}, error)
	StartVideoStreamWithOffer(ctx context.Context, req display.VideoStreamRequest, offer []byte) (uuid.UUID, map[string]interface{}, error)
	StopMediaStreamScoped(ctx context.Context, clientSessionID uuid.UUID, stopAll bool) error
	Close() error
}

// sessionDisplayService owns a display-lifetime XPC connection to
// com.apple.coredevice.displayservice. Each dial binds the underlying tunnel
// TCP socket to the display pipeline's lifetime rather than a temporary
// startup/negotiation context so canceling startup after negotiation succeeds
// does not tear down the cached connection needed for later scoped stops.
type sessionDisplayService struct {
	life   context.Context
	open   func(context.Context) (displayServiceClient, error)
	mu     sync.Mutex
	svc    displayServiceClient
	cancel context.CancelFunc
}

func newSessionDisplayService(life context.Context, session *phone.Session) *sessionDisplayService {
	return &sessionDisplayService{
		life: life,
		open: func(ctx context.Context) (displayServiceClient, error) {
			conn, err := session.OpenXPC(ctx, phone.DisplayService)
			if err != nil {
				return nil, err
			}
			return display.NewWithConnection(conn), nil
		},
	}
}

func (s *sessionDisplayService) ensure(ctx context.Context) (displayServiceClient, context.CancelFunc, error) {
	if err := ctx.Err(); err != nil {
		return nil, nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.svc != nil {
		return s.svc, s.cancel, nil
	}
	base := s.life
	if base == nil {
		base = context.Background()
	}
	if err := base.Err(); err != nil {
		return nil, nil, err
	}
	connCtx, connCancel := context.WithCancel(base)
	abortDial := context.AfterFunc(ctx, connCancel)
	svc, err := s.open(connCtx)
	aborted := !abortDial()
	if err != nil {
		connCancel()
		return nil, nil, err
	}
	if aborted || ctx.Err() != nil {
		connCancel()
		_ = svc.Close()
		return nil, nil, ctx.Err()
	}
	s.svc = svc
	s.cancel = connCancel
	return s.svc, connCancel, nil
}

func (s *sessionDisplayService) reset(target displayServiceClient) {
	s.mu.Lock()
	var cancel context.CancelFunc
	if s.svc == target {
		s.svc = nil
		cancel = s.cancel
		s.cancel = nil
	}
	s.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	if target != nil {
		_ = target.Close()
	}
}

func (s *sessionDisplayService) StartAudioStreamWithOffer(ctx context.Context, req display.AudioStreamRequest, offer []byte) (uuid.UUID, map[string]interface{}, error) {
	svc, connCancel, err := s.ensure(ctx)
	if err != nil {
		return uuid.Nil, nil, err
	}
	abortCall := context.AfterFunc(ctx, connCancel)
	id, output, err := svc.StartAudioStreamWithOffer(ctx, req, offer)
	aborted := !abortCall()
	if err != nil || aborted || ctx.Err() != nil {
		s.reset(svc)
		if err == nil {
			err = ctx.Err()
		}
	}
	return id, output, err
}

func (s *sessionDisplayService) StartVideoStreamWithOffer(ctx context.Context, req display.VideoStreamRequest, offer []byte) (uuid.UUID, map[string]interface{}, error) {
	svc, connCancel, err := s.ensure(ctx)
	if err != nil {
		return uuid.Nil, nil, err
	}
	abortCall := context.AfterFunc(ctx, connCancel)
	id, output, err := svc.StartVideoStreamWithOffer(ctx, req, offer)
	aborted := !abortCall()
	if err != nil || aborted || ctx.Err() != nil {
		s.reset(svc)
		if err == nil {
			err = ctx.Err()
		}
	}
	return id, output, err
}

func (s *sessionDisplayService) StopMediaStreamScoped(ctx context.Context, clientSessionID uuid.UUID, stopAll bool) error {
	s.mu.Lock()
	hadCached := s.svc != nil
	s.mu.Unlock()

	svc, connCancel, err := s.ensure(ctx)
	if err != nil {
		return err
	}
	abortCall := context.AfterFunc(ctx, connCancel)
	err = svc.StopMediaStreamScoped(ctx, clientSessionID, stopAll)
	aborted := !abortCall()
	s.reset(svc)
	if err == nil && !aborted && ctx.Err() == nil {
		return nil
	}
	// If a previously cached XPC connection was closed by the device while idle,
	// open one fresh connection to deliver the scoped stop cleanly.
	if hadCached && !aborted && ctx.Err() == nil {
		fresh, freshCancel, dialErr := s.ensure(ctx)
		if dialErr != nil {
			return err
		}
		abortRetry := context.AfterFunc(ctx, freshCancel)
		retryErr := fresh.StopMediaStreamScoped(ctx, clientSessionID, stopAll)
		retryAborted := !abortRetry()
		s.reset(fresh)
		if retryErr == nil && !retryAborted && ctx.Err() == nil {
			return nil
		}
		if retryErr != nil {
			return retryErr
		}
		return ctx.Err()
	}
	if err != nil {
		return err
	}
	return ctx.Err()
}

func (s *sessionDisplayService) Close() error {
	s.mu.Lock()
	svc := s.svc
	cancel := s.cancel
	s.svc = nil
	s.cancel = nil
	s.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	if svc != nil {
		return svc.Close()
	}
	return nil
}

type mediaPipelineAdapter struct {
	pipeline *media.Pipeline
}

func (a mediaPipelineAdapter) Start(ctx context.Context) (string, error) {
	return a.pipeline.Start(ctx)
}

func (a mediaPipelineAdapter) ApplyDemand(maxLongSide, maxFPS *int, active *bool) {
	a.pipeline.ApplyDemand(maxLongSide, maxFPS, active)
}

func (a mediaPipelineAdapter) RequestKeyframe() {
	a.pipeline.RequestKeyframe()
}

func (a mediaPipelineAdapter) LatestFrame(maxAge time.Duration) (*phone.MediaFrame, bool) {
	frame, ok := a.pipeline.LatestFrame(maxAge)
	if !ok || frame == nil {
		return nil, false
	}
	return &phone.MediaFrame{
		JPEG:       frame.JPEG,
		RGBA:       frame.RGBA,
		Width:      frame.Width,
		Height:     frame.Height,
		DisplayID:  frame.DisplayID,
		Rotation:   frame.Rotation,
		CapturedAt: frame.CapturedAt,
	}, true
}

func (a mediaPipelineAdapter) SetPrivacyHidden(state, reason string) {
	a.pipeline.SetPrivacyHidden(state, reason)
}

func (a mediaPipelineAdapter) ResumeVisible(displayID uint64, rotation int) {
	a.pipeline.ResumeVisible(displayID, rotation)
}

func (a mediaPipelineAdapter) Stop(ctx context.Context) error {
	return a.pipeline.Stop(ctx)
}

func newMediaPipeline(life context.Context, session *phone.Session, cfg phone.MediaPipelineConfig) (phone.MediaPipeline, error) {
	mediaCfg := media.PipelineConfig{
		StreamID:    cfg.StreamID,
		DisplayID:   cfg.DisplayID,
		Rotation:    cfg.Rotation,
		MaxLongSide: cfg.MaxLongSide,
		MaxFPS:      cfg.MaxFPS,
		SocketPath:  cfg.SocketPath,
	}
	if cfg.OnState != nil {
		onState := cfg.OnState
		mediaCfg.OnState = func(event media.DisplayEvent) {
			onState(phone.DisplayStateEvent{
				StreamID:   event.StreamID,
				State:      event.State,
				Reason:     event.Reason,
				Generation: event.Generation,
				Width:      event.Width,
				Height:     event.Height,
				Rotation:   event.Rotation,
			})
		}
	}
	pipeline, err := media.NewPipeline(mediaCfg, session.MediaUDP(life), newSessionDisplayService(life, session))
	if err != nil {
		return nil, err
	}
	return mediaPipelineAdapter{pipeline: pipeline}, nil
}

func recognizeFrameOCR(ctx context.Context, frame phone.MediaFrame) ([]phone.OCRBox, error) {
	var (
		boxes []media.OCRBox
		err   error
	)
	if len(frame.RGBA) > 0 && frame.Width > 0 && frame.Height > 0 {
		boxes, err = media.RecognizeTextRGBA(ctx, frame.RGBA, frame.Width, frame.Height)
	} else {
		boxes, err = media.RecognizeTextJPEG(ctx, frame.JPEG)
	}
	if err != nil {
		return nil, err
	}
	out := make([]phone.OCRBox, len(boxes))
	for i, box := range boxes {
		out[i] = phone.OCRBox{
			Text:       box.Text,
			X:          box.X,
			Y:          box.Y,
			Width:      box.Width,
			Height:     box.Height,
			Confidence: box.Confidence,
		}
	}
	return out, nil
}
