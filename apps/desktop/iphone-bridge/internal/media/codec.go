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

type decodedPicture struct {
	rgba          []byte
	width, height int
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
	encode(picture decodedPicture, fps int, ptsUs uint64, force bool) (encodedPicture, error)
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
	return decodedPicture{dst.Pix, width, height}
}

func snapshotJPEG(picture decodedPicture) ([]byte, error) {
	img := &image.RGBA{Pix: picture.rgba, Stride: picture.width * 4, Rect: image.Rect(0, 0, picture.width, picture.height)}
	var out bytes.Buffer
	if err := jpeg.Encode(&out, img, &jpeg.Options{Quality: 82}); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}
