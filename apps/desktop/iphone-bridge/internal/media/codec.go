package media

import (
	"bytes"
	"errors"
	"image"
	"image/jpeg"
	"time"

	"golang.org/x/image/draw"
)

const maxPictureDimension = 4096

var (
	ErrVisionUnavailable       = errors.New("vision unavailable")
	ErrVideoToolboxUnavailable = errors.New("videotoolbox unavailable")
)

type VideoFrame struct {
	JPEG       []byte
	RGBA       []byte
	Width      int
	Height     int
	DisplayID  uint64
	Rotation   int
	CapturedAt time.Time
}

type OCRBox struct {
	Text                string
	X, Y, Width, Height float64
	Confidence          float64
}

// pictureSurface is an optional GPU-backed pixel buffer (CVPixelBuffer on
// macOS) that can be hardware-scaled and encoded without CPU pixel copies,
// and converted to RGBA only on demand for agent observation.
type pictureSurface interface {
	retain() pictureSurface
	release()
	toRGBA(width, height int) ([]byte, error)
}

type decodedPicture struct {
	rgba          []byte
	surface       pictureSurface
	width, height int
}

func (p decodedPicture) valid() bool {
	if !validDimensions(p.width, p.height) {
		return false
	}
	if p.surface != nil {
		return true
	}
	return len(p.rgba) == p.width*p.height*4
}

func (p decodedPicture) retain() decodedPicture {
	if p.surface != nil {
		surf := p.surface.retain()
		if surf == nil {
			return decodedPicture{}
		}
		return decodedPicture{surface: surf, width: p.width, height: p.height}
	}
	return decodedPicture{rgba: bytes.Clone(p.rgba), width: p.width, height: p.height}
}

func (p *decodedPicture) release() {
	if p.surface != nil {
		p.surface.release()
		p.surface = nil
	}
	if len(p.rgba) != 0 {
		clear(p.rgba)
		p.rgba = nil
	}
	p.width, p.height = 0, 0
}

func (p decodedPicture) materializeRGBA(width, height int) ([]byte, error) {
	if p.surface != nil {
		return p.surface.toRGBA(width, height)
	}
	scaled := scalePicture(p, width, height)
	if width == p.width && height == p.height {
		return bytes.Clone(scaled.rgba), nil
	}
	return scaled.rgba, nil
}

type encodedPicture struct {
	annexB []byte
	key    bool
	codec  string
}

// Individual decoder and encoder instances can run concurrently. The pipeline
// accepts a factory internally so synthetic tests can exercise the real socket.
type videoDecoder interface {
	decode(unit accessUnit, codec string) (decodedPicture, error)
	close()
}

type videoEncoder interface {
	encode(picture decodedPicture, width, height, fps int, ptsUs uint64, force bool) (encodedPicture, error)
	close()
}

type codecFactory struct {
	decoder func() videoDecoder
	encoder func() videoEncoder
}

func validDimensions(width, height int) bool {
	return width > 0 && height > 0 && width <= maxPictureDimension && height <= maxPictureDimension
}

func scaledDimensions(width, height, limit int, even bool) (int, int) {
	longSide := max(width, height)
	if longSide > limit {
		width, height = max(1, width*limit/longSide), max(1, height*limit/longSide)
	}
	if even {
		width, height = max(2, width&^1), max(2, height&^1)
	}
	return width, height
}

// The result borrows the input pixels when the geometry already matches.
func scalePicture(input decodedPicture, width, height int) decodedPicture {
	if input.width == width && input.height == height {
		return input
	}
	src := &image.RGBA{Pix: input.rgba, Stride: input.width * 4, Rect: image.Rect(0, 0, input.width, input.height)}
	dst := image.NewRGBA(image.Rect(0, 0, width, height))
	draw.ApproxBiLinear.Scale(dst, dst.Bounds(), src, src.Bounds(), draw.Src, nil)
	return decodedPicture{rgba: dst.Pix, width: width, height: height}
}

func snapshotJPEG(picture decodedPicture) ([]byte, error) {
	img := &image.RGBA{Pix: picture.rgba, Stride: picture.width * 4, Rect: image.Rect(0, 0, picture.width, picture.height)}
	var out bytes.Buffer
	if err := jpeg.Encode(&out, img, &jpeg.Options{Quality: 82}); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}
