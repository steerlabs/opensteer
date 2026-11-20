package phone

import (
	"context"
	"errors"
	"log/slog"
	"slices"

	"github.com/steerlabs/opensteer/iphone-bridge/internal/wire"
)

func (m *Manager) mountSelectedImage(ctx context.Context, p *localPhone, s *Session, path string) error {
	image, err := ValidateImage(path)
	if err != nil {
		return err
	}
	defer image.Close()
	m.mu.Lock()
	root := m.rootPath
	m.mu.Unlock()
	staged, cleanup, err := image.Stage(ctx, root)
	if err != nil {
		return err
	}
	defer cleanup()
	return m.mountImage(ctx, s, m.device(p), staged)
}

func servicePresent(s *Session, name string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.services.GetPort(name) > 0
}

func developerServicesPresent(s *Session) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.services.GetPort(screenshotService) > 0 && s.services.GetPort(hidService) > 0 && s.services.GetPort(deviceInfoService) > 0
}

// ensureDeveloperServices is the single setup and runtime gate for DDI-backed services.
// It reuses live services already exposed by the iPhone and only mounts a local DDI when missing.
func (m *Manager) ensureDeveloperServices(ctx context.Context, p *localPhone, s *Session) error {
	if s.newRSD != nil {
		if err := s.Refresh(ctx); err != nil {
			s.setDDIReason("")
			return err
		}
	}
	if developerServicesPresent(s) {
		s.setDDIReason("")
		slog.Debug("bridge.service", "service", "developer-image", "reason", "already-present")
		return nil
	}
	failDDI := func(err error, fallback wire.Reason) error {
		s.setDDIReason(Classify(err, fallback).Code)
		return err
	}
	m.mu.Lock()
	paths := slices.Clone(m.imagePaths)
	m.mu.Unlock()
	if len(paths) == 0 {
		slog.Debug("bridge.service", "service", "developer-image", "reason", string(wire.ImageMissing))
		return failDDI(wire.Fail(wire.ImageMissing), wire.ImageMissing)
	}
	var lastIncompatible error
	allMissing := true
	for _, path := range paths {
		err := m.mountSelectedImage(ctx, p, s, path)
		if err == nil {
			if !developerServicesPresent(s) {
				slog.Debug("bridge.service", "service", "developer-image", "reason", string(wire.ServiceMissing))
				return failDDI(wire.Fail(wire.ServiceMissing), wire.ServiceMissing)
			}
			s.setDDIReason("")
			slog.Debug("bridge.service", "service", "developer-image", "reason", "mounted")
			return nil
		}
		var failure *wire.Failure
		if errors.As(err, &failure) {
			if failure.Code == wire.ImageMissing {
				continue
			}
			allMissing = false
			if failure.Code == wire.ImageIncompatible {
				lastIncompatible = err
				continue
			}
			slog.Debug("bridge.service", "service", "developer-image", "reason", string(failure.Code))
			return failDDI(err, wire.ImageMountFailed)
		}
		allMissing = false
		return failDDI(err, wire.ImageMountFailed)
	}
	if allMissing {
		slog.Debug("bridge.service", "service", "developer-image", "reason", string(wire.ImageMissing))
		return failDDI(wire.Fail(wire.ImageMissing), wire.ImageMissing)
	}
	slog.Debug("bridge.service", "service", "developer-image", "reason", string(wire.ImageIncompatible))
	if lastIncompatible != nil {
		return failDDI(lastIncompatible, wire.ImageIncompatible)
	}
	return failDDI(wire.Fail(wire.ImageIncompatible), wire.ImageIncompatible)
}
