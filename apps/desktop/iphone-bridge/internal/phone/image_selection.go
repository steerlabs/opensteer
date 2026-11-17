package phone

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"syscall"

	"github.com/google/uuid"
	"github.com/steerlabs/opensteer/iphone-bridge/internal/wire"
)

func (m *Manager) loadSelectedImages() error {
	f, err := m.root.OpenFile("images.v1.json", os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return wire.Fail(wire.NotInitialized)
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || !privateFile(info) {
		return wire.Fail(wire.NotInitialized)
	}
	data, err := io.ReadAll(io.LimitReader(f, 300001))
	if err != nil || len(data) > 300000 {
		return wire.Fail(wire.NotInitialized)
	}
	selected := map[string]string{}
	if wire.StrictDecode(data, &selected) != nil || len(selected) > 64 {
		return wire.Fail(wire.NotInitialized)
	}
	for id, path := range selected {
		if (len(id) == 0 || len(id) > 128) || !filepath.IsAbs(path) || len(path) > 4096 {
			return wire.Fail(wire.NotInitialized)
		}
	}
	m.selectedImages = selected
	return nil
}
func (m *Manager) saveSelectedImages() error {
	data, err := json.Marshal(m.selectedImages)
	if err != nil {
		return err
	}
	name := "images-" + uuid.New().String() + ".tmp"
	f, err := m.root.OpenFile(name, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return Classify(err, wire.NativeServiceFailed)
	}
	defer m.root.Remove(name)
	_, err = f.Write(data)
	if err == nil {
		err = f.Sync()
	}
	err = errors.Join(err, f.Close())
	if err == nil {
		err = m.root.Rename(name, "images.v1.json")
	}
	if err == nil {
		directory, e := m.root.Open(".")
		if e == nil {
			err = errors.Join(directory.Sync(), directory.Close())
		} else {
			err = e
		}
	}
	return ClassifyOrNil(err, wire.NativeServiceFailed)
}
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
func developerServicesPresent(s *Session) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.services.GetPort(screenshotService) > 0 && s.services.GetPort(hidService) > 0 && s.services.GetPort(deviceInfoService) > 0
}
func (m *Manager) ensureDeveloperServices(ctx context.Context, p *localPhone, s *Session) error {
	m.mu.Lock()
	path := m.selectedImages[p.identity]
	m.mu.Unlock()
	if path == "" {
		return nil
	}
	if err := s.Refresh(ctx); err != nil {
		return err
	}
	if developerServicesPresent(s) {
		return nil
	}
	if err := m.mountSelectedImage(ctx, p, s, path); err != nil {
		return err
	}
	if !developerServicesPresent(s) {
		return wire.Fail(wire.ServiceMissing)
	}
	return nil
}
