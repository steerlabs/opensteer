package phone

import (
	"bytes"
	"image"
	"image/jpeg"
	"image/png"
	"math"

	"github.com/steerlabs/opensteer/iphone-bridge/internal/wire"
	"golang.org/x/image/draw"
)

type Geometry struct {
	Width           int    `json:"width"`
	Height          int    `json:"height"`
	CaptureWidth    int    `json:"captureWidth"`
	CaptureHeight   int    `json:"captureHeight"`
	DisplayID       uint64 `json:"displayId"`
	DisplayUniqueID string `json:"-"`
	Rotation        *int   `json:"rotation"`
}

func encodeScreenshot(data []byte) ([]byte, Geometry, error) {
	var g Geometry
	if len(data) == 0 || len(data) > 32<<20 {
		return nil, g, wire.Fail(wire.NativeLimit)
	}
	cfg, err := png.DecodeConfig(bytes.NewReader(data))
	if err != nil || cfg.Width < 2 || cfg.Height < 2 || int64(cfg.Width)*int64(cfg.Height) > 32000000 {
		return nil, g, wire.Fail(wire.NativeLimit)
	}
	source, err := png.Decode(bytes.NewReader(data))
	if err != nil {
		return nil, g, wire.Fail(wire.NativeServiceFailed)
	}
	return encodeScreenImage(source, cfg.Width, cfg.Height)
}
func matchingAspect(w, h, otherW, otherH float64) bool {
	return w > 0 && h > 0 && otherW > 0 && otherH > 0 && math.Abs((w/h)/(otherW/otherH)-1) < 0.02
}
func encodeMediaScreenshot(frame *MediaFrame) ([]byte, Geometry, error) {
	w, h := frame.Width, frame.Height
	var source image.Image
	if len(frame.JPEG) > 0 {
		c, err := jpeg.DecodeConfig(bytes.NewReader(frame.JPEG))
		if err != nil || c.Width != w || c.Height != h {
			return nil, Geometry{}, wire.Fail(wire.NativeLimit)
		}
		if max(w, h) <= 1440 && w*h <= 1150000 && (len(frame.JPEG)+2)/3*4 <= 600000 {
			return frame.JPEG, Geometry{Width: w, Height: h, CaptureWidth: w, CaptureHeight: h}, nil
		}
		source, err = jpeg.Decode(bytes.NewReader(frame.JPEG))
		if err != nil {
			return nil, Geometry{}, wire.Fail(wire.NativeServiceFailed)
		}
	} else if len(frame.RGBA) == w*h*4 {
		source = &image.RGBA{Pix: frame.RGBA, Stride: w * 4, Rect: image.Rect(0, 0, w, h)}
	} else {
		return nil, Geometry{}, wire.Fail(wire.NativeServiceFailed)
	}
	return encodeScreenImage(source, w, h)
}
func encodeScreenImage(source image.Image, captureWidth, captureHeight int) ([]byte, Geometry, error) {
	var g Geometry
	scale := math.Min(1, math.Min(1440/float64(max(captureWidth, captureHeight)), math.Sqrt(1150000/float64(captureWidth*captureHeight))))
	width, height := max(2, int(float64(captureWidth)*scale)), max(2, int(float64(captureHeight)*scale))
	for range 8 {
		output := image.NewRGBA(image.Rect(0, 0, width, height))
		draw.BiLinear.Scale(output, output.Bounds(), source, source.Bounds(), draw.Src, nil)
		for _, quality := range []int{80, 65, 50, 35} {
			var b bytes.Buffer
			if err := jpeg.Encode(&b, output, &jpeg.Options{Quality: quality}); err != nil {
				return nil, g, wire.Fail(wire.NativeServiceFailed)
			}
			if (b.Len()+2)/3*4 <= 600000 {
				return b.Bytes(), Geometry{Width: width, Height: height, CaptureWidth: captureWidth, CaptureHeight: captureHeight}, nil
			}
		}
		width = max(2, width*3/4)
		height = max(2, height*3/4)
	}
	return nil, g, wire.Fail(wire.NativeLimit)
}
func (g Geometry) Normalize(p wire.Point) (wire.Point, error) {
	if g.Rotation == nil || g.Width < 2 || g.Height < 2 {
		return wire.Point{}, wire.Fail(wire.GeometryUnavailable)
	}
	if !finite(p.X) || !finite(p.Y) || p.X < 0 || p.Y < 0 || p.X > float64(g.Width-1) || p.Y > float64(g.Height-1) {
		return wire.Point{}, wire.Fail(wire.StaleObservation)
	}

	x, y := p.X/float64(g.Width-1), p.Y/float64(g.Height-1)
	var transform affine
	switch *g.Rotation {
	case 0:
		transform = affine{A: 1, D: 1}
	case 90:
		transform = affine{C: 1, B: -1, TY: 1}
	case 180:
		transform = affine{A: -1, D: -1, TX: 1, TY: 1}
	case 270:
		transform = affine{C: -1, B: 1, TX: 1}
	default:
		return wire.Point{}, wire.Fail(wire.GeometryUnavailable)
	}
	return transform.point(wire.Point{X: x, Y: y})
}
func finite(f float64) bool { return !math.IsInf(f, 0) && !math.IsNaN(f) }

type affine struct{ A, B, C, D, TX, TY float64 }

func (t affine) point(p wire.Point) (wire.Point, error) {
	x, y := t.A*p.X+t.C*p.Y+t.TX, t.B*p.X+t.D*p.Y+t.TY
	if !finite(x) || !finite(y) {
		return wire.Point{}, wire.Fail(wire.GeometryUnavailable)
	}
	return wire.Point{X: x, Y: y}, nil
}
