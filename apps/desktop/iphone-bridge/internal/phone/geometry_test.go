package phone

import (
	"bytes"
	"github.com/steerlabs/opensteer/iphone-bridge/internal/wire"
	"image"
	"image/png"
	"math"
	"testing"
)

func TestDeliveredGeometryAndHIDCorners(t *testing.T) {
	var b bytes.Buffer
	if err := png.Encode(&b, image.NewNRGBA(image.Rect(0, 0, 1290, 2796))); err != nil {
		t.Fatal(err)
	}
	jpeg, g, err := encodeScreenshot(b.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	cfg, _, err := image.DecodeConfig(bytes.NewReader(jpeg))
	if err != nil || cfg.Width != g.Width || cfg.Height != g.Height || g.Width*g.Height > 1150000 || max(g.Width, g.Height) > 1440 {
		t.Fatalf("geometry disagrees with image: %+v %v", g, err)
	}
	for _, rotation := range []int{0, 90, 180, 270} {
		g.Rotation = &rotation
		p, err := g.Normalize(wire.Point{X: 0, Y: 0})
		if err != nil || math.IsNaN(p.X) || p.X < 0 || p.X > 1 || p.Y < 0 || p.Y > 1 {
			t.Fatalf("rotation %d: %+v %v", rotation, p, err)
		}
	}
	if _, err := g.Normalize(wire.Point{X: float64(g.Width), Y: 0}); err == nil {
		t.Fatal("silently clamped outside image")
	}
	if _, _, err := encodeScreenshot(make([]byte, 33<<20)); err == nil {
		t.Fatal("oversized PNG accepted")
	}
}
func TestNormalizedRotationCornersAndPixelCenters(t *testing.T) {
	for _, test := range []struct {
		rotation int
		corner   wire.Point
	}{{0, wire.Point{X: 0, Y: 0}}, {90, wire.Point{X: 0, Y: 1}}, {180, wire.Point{X: 1, Y: 1}}, {270, wire.Point{X: 1, Y: 0}}} {
		g := Geometry{Width: 100, Height: 200, Rotation: &test.rotation}
		p, e := g.Normalize(wire.Point{})
		if e != nil || p != test.corner {
			t.Fatalf("rotation %d: %+v %v", test.rotation, p, e)
		}
		p, e = g.Normalize(wire.Point{X: 49.5, Y: 99.5})
		if e != nil || p.X != 0.5 || p.Y != 0.5 {
			t.Fatal("pixel-center transform drifted")
		}
	}
	g := Geometry{Width: 100, Height: 200}
	if _, e := g.Normalize(wire.Point{}); e == nil {
		t.Fatal("unknown rotation admitted")
	}
}
