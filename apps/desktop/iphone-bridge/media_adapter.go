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

type sessionDisplayService struct {
	session *phone.Session
	mu      sync.Mutex
	svc     *display.Service
}

func (s *sessionDisplayService) ensure(ctx context.Context) (*display.Service, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.svc != nil {
		return s.svc, nil
	}
	conn, err := s.session.OpenXPC(ctx, phone.DisplayService)
	if err != nil {
		return nil, err
	}
	s.svc = display.NewWithConnection(conn)
	return s.svc, nil
}

func (s *sessionDisplayService) reset(target *display.Service) {
	s.mu.Lock()
	if s.svc == target {
		s.svc = nil
	}
	s.mu.Unlock()
	if target != nil {
		_ = target.Close()
	}
}

func (s *sessionDisplayService) StartAudioStreamWithOffer(ctx context.Context, req display.AudioStreamRequest, offer []byte) (uuid.UUID, map[string]interface{}, error) {
	svc, err := s.ensure(ctx)
	if err != nil {
		return uuid.Nil, nil, err
	}
	id, output, err := svc.StartAudioStreamWithOffer(ctx, req, offer)
	if err != nil {
		s.reset(svc)
	}
	return id, output, err
}

func (s *sessionDisplayService) StartVideoStreamWithOffer(ctx context.Context, req display.VideoStreamRequest, offer []byte) (uuid.UUID, map[string]interface{}, error) {
	svc, err := s.ensure(ctx)
	if err != nil {
		return uuid.Nil, nil, err
	}
	id, output, err := svc.StartVideoStreamWithOffer(ctx, req, offer)
	if err != nil {
		s.reset(svc)
	}
	return id, output, err
}

func (s *sessionDisplayService) StopMediaStreamScoped(ctx context.Context, clientSessionID uuid.UUID, stopAll bool) error {
	svc, err := s.ensure(ctx)
	if err != nil {
		return err
	}
	err = svc.StopMediaStreamScoped(ctx, clientSessionID, stopAll)
	s.reset(svc)
	return err
}

func (s *sessionDisplayService) Close() error {
	s.mu.Lock()
	svc := s.svc
	s.svc = nil
	s.mu.Unlock()
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

func (a mediaPipelineAdapter) UpdateDemand(maxLongSide, maxFPS int) {
	a.pipeline.UpdateDemand(maxLongSide, maxFPS)
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
	pipeline, err := media.NewPipeline(mediaCfg, session.MediaUDP(life), &sessionDisplayService{session: session})
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
