package phone

import (
	"context"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"github.com/danielpaulus/go-ios/ios"
	"github.com/danielpaulus/go-ios/ios/imagemounter"
	"github.com/steerlabs/opensteer/iphone-bridge/internal/wire"
	"howett.net/plist"
)

const maxImageBytes int64 = 2 << 30

// Xcode 27.2 has a 785 KiB manifest, 141 identities and six shared files.
const maxManifestBytes int64 = 8 << 20
const maxBuildIdentities = 1024
const maxIdentityEntries = 16
const maxImageFiles = 256

type imageManifest struct {
	ProductBuildVersion string
	BuildIdentities     []struct {
		Manifest map[string]struct{ Info struct{ Path string } }
	}
}
type Image struct {
	root     *os.Root
	manifest []byte
	files    []string
	Build    string
}

func (i *Image) Close() error { return i.root.Close() }
func ValidateImage(directory string) (*Image, error) {
	if !filepath.IsAbs(directory) {
		return nil, wire.Fail(wire.ImageIncompatible)
	}
	root, err := os.OpenRoot(directory)
	if err != nil {
		return nil, wire.Fail(wire.ImageMissing)
	}
	reject := func() (*Image, error) { root.Close(); return nil, wire.Fail(wire.ImageIncompatible) }
	f, err := root.Open("BuildManifest.plist")
	if err != nil {
		return reject()
	}
	raw, err := io.ReadAll(io.LimitReader(f, maxManifestBytes+1))
	f.Close()
	if err != nil || int64(len(raw)) > maxManifestBytes {
		return reject()
	}
	var m imageManifest
	if _, err := plist.Unmarshal(raw, &m); err != nil || len(m.BuildIdentities) < 1 || len(m.BuildIdentities) > maxBuildIdentities || len(m.ProductBuildVersion) < 1 || len(m.ProductBuildVersion) > 128 {
		return reject()
	}
	paths := map[string]bool{}
	var total int64
	for _, identity := range m.BuildIdentities {
		if len(identity.Manifest) == 0 || len(identity.Manifest) > maxIdentityEntries {
			return reject()
		}
		for key, entry := range identity.Manifest {
			p := entry.Info.Path
			if p == "" {
				continue
			}
			if len(p) > 4096 || !fs.ValidPath(p) || strings.Contains(p, ":") || strings.Contains(p, "\\") || p == "BuildManifest.plist" {
				return reject()
			}
			if paths[p] {
				continue
			}
			components := strings.Split(p, "/")
			for n := range components {
				info, err := root.Lstat(strings.Join(components[:n+1], "/"))
				if err != nil || info.Mode()&os.ModeSymlink != 0 {
					return reject()
				}
			}
			f, err := root.Open(p)
			if err != nil {
				return reject()
			}
			info, err := f.Stat()
			f.Close()
			if err != nil || !info.Mode().IsRegular() || info.Size() == 0 || info.Size() > maxImageBytes {
				return reject()
			}
			if (key == "LoadableTrustCache" || key == "Cryptex1,GenericTrustCache" || key == "Cryptex1,CryptexInfoPlist") && info.Size() > maxManifestBytes {
				return reject()
			}
			total += info.Size()
			if total > maxImageBytes || len(paths) >= maxImageFiles {
				return reject()
			}
			paths[p] = true
		}
		personalized := identity.Manifest["PersonalizedDMG"].Info.Path != "" || identity.Manifest["PersonalizedDmg"].Info.Path != ""
		cryptex := identity.Manifest["Cryptex1,GenericDmg"].Info.Path != ""
		if !personalized && !cryptex {
			return reject()
		}
		if personalized && identity.Manifest["LoadableTrustCache"].Info.Path == "" {
			return reject()
		}
		if cryptex {
			for _, key := range []string{"Cryptex1,GenericTrustCache", "Cryptex1,GenericVolume", "Cryptex1,CryptexInfoPlist"} {
				if identity.Manifest[key].Info.Path == "" {
					return reject()
				}
			}
		}
	}
	image := &Image{root: root, manifest: raw, Build: m.ProductBuildVersion}
	for p := range paths {
		image.files = append(image.files, p)
	}
	return image, nil
}

// Stage from contained file handles so upstream path-based readers see an immutable private copy.
func (i *Image) Stage(ctx context.Context, privateRoot string) (string, func(), error) {
	dir, err := os.MkdirTemp(privateRoot, "image-")
	if err != nil {
		return "", nil, wire.Fail(wire.ImageIncompatible)
	}
	cleanup := func() { _ = os.RemoveAll(dir) }
	if err := os.WriteFile(filepath.Join(dir, "BuildManifest.plist"), i.manifest, 0600); err != nil {
		cleanup()
		return "", nil, err
	}
	var total int64
	for _, p := range i.files {
		if ctx.Err() != nil {
			cleanup()
			return "", nil, ctx.Err()
		}
		source, err := i.root.Open(p)
		if err != nil {
			cleanup()
			return "", nil, wire.Fail(wire.ImageIncompatible)
		}
		target := filepath.Join(dir, p)
		if err := os.MkdirAll(filepath.Dir(target), 0700); err != nil {
			source.Close()
			cleanup()
			return "", nil, err
		}
		out, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if err != nil {
			source.Close()
			cleanup()
			return "", nil, err
		}
		n, copyErr := io.Copy(out, io.LimitReader(contextReader{ctx, source}, maxImageBytes-total+1))
		closeErr := out.Close()
		source.Close()
		total += n
		if copyErr != nil || closeErr != nil || total > maxImageBytes {
			cleanup()
			return "", nil, wire.Fail(wire.ImageIncompatible)
		}
	}
	return dir, cleanup, nil
}

type contextReader struct {
	ctx context.Context
	r   io.Reader
}

func (r contextReader) Read(b []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.r.Read(b)
}
func MountDeveloperImage(ctx context.Context, session *Session, d ios.DeviceEntry, path string) error {
	d = session.Device(ctx, d)
	m, err := imagemounter.NewImageMounter(d)
	if err != nil {
		return Classify(err, wire.ImageMountFailed)
	}
	defer m.Close()
	existing, err := m.ListImages()
	if err != nil {
		return Classify(err, wire.ImageMountFailed)
	}
	if len(existing) > 0 {
		same, err := m.IsImageMounted(path)
		if err != nil {
			return Classify(err, wire.ImageIncompatible)
		}
		if same {
			return session.Refresh(ctx)
		}
		return wire.Fail(wire.PhoneInUse)
	}
	if err := m.MountImage(path); err != nil {
		if imagemounter.IsImageIncompatible(err) {
			return wire.Fail(wire.ImageIncompatible)
		}
		var personalization *imagemounter.PersonalizationError
		if errors.As(err, &personalization) {
			if personalization.Network {
				return wire.Fail(wire.PersonalizationNetwork)
			}
			return wire.Fail(wire.PersonalizationRejected)
		}
		failure := Classify(err, wire.ImageMountFailed)
		failure.Effect = "unknown"
		return failure
	}
	return session.Refresh(ctx)
}
