//go:build darwin && cgo

package media

import (
	"bytes"
	"context"
	"encoding/hex"
	"errors"
	"image"
	"image/color"
	"image/draw"
	"image/jpeg"
	"strings"
	"testing"

	"golang.org/x/image/font"
	"golang.org/x/image/font/gofont/goregular"
	"golang.org/x/image/font/opentype"
	"golang.org/x/image/math/fixed"
)

const syntheticText = "OPENSTEER MEDIA TEST"

func renderAndDecodeTestPicture(t *testing.T) decodedPicture {
	t.Helper()
	fontFile, err := opentype.Parse(goregular.TTF)
	if err != nil {
		t.Fatal(err)
	}
	face, err := opentype.NewFace(fontFile, &opentype.FaceOptions{Size: 44, DPI: 72, Hinting: font.HintingFull})
	if err != nil {
		t.Fatal(err)
	}
	defer face.Close()
	const width, height = 640, 360
	picture := image.NewRGBA(image.Rect(0, 0, width, height))
	draw.Draw(picture, picture.Bounds(), image.White, image.Point{}, draw.Src)
	writer := font.Drawer{Dst: picture, Src: image.NewUniform(color.Black), Face: face, Dot: fixed.P(30, 100)}
	writer.DrawString(syntheticText)

	encoder := &vtEncoder{}
	defer encoder.close()
	encoded, err := encoder.encode(decodedPicture{picture.Pix, width, height}, 30, 0, true)
	if err != nil {
		t.Fatal(err)
	}
	nals := annexNALs(encoded.annexB)
	if len(nals) < 3 || nals[0][0]&31 != 7 || nals[1][0]&31 != 8 || !encoded.key ||
		encoded.codec != "avc1."+hex.EncodeToString(nals[0][1:4]) {
		t.Fatal("missing SPS/PPS, key flag or SPS-derived codec")
	}
	second, err := encoder.encode(decodedPicture{picture.Pix, width, height}, 30, 33333, false)
	if err != nil || second.key || second.codec != "" {
		t.Fatalf("second frame should be a delta: key=%v codec=%q err=%v", second.key, second.codec, err)
	}
	forced, err := encoder.encode(decodedPicture{picture.Pix, width, height}, 30, 66666, true)
	if err != nil || !forced.key || forced.codec != encoded.codec {
		t.Fatalf("forced frame was not an IDR: key=%v codec=%q err=%v", forced.key, forced.codec, err)
	}

	decoder := &vtDecoder{}
	defer decoder.close()
	decoded, err := decoder.decode(accessUnit{annexB: encoded.annexB, key: true}, "avc")
	if err != nil || decoded.width != width || decoded.height != height || len(decoded.rgba) != width*height*4 {
		t.Fatalf("decoded %dx%d, %d bytes: %v", decoded.width, decoded.height, len(decoded.rgba), err)
	}
	if _, err := decoder.decode(accessUnit{annexB: second.annexB}, "avc"); err != nil {
		t.Fatal(err)
	}
	return decoded
}

func TestVideoToolboxEncodeDecodeJPEG(t *testing.T) {
	decoded := renderAndDecodeTestPicture(t)
	jpg, err := snapshotJPEG(decoded)
	if err != nil {
		t.Fatal(err)
	}
	if cfg, err := jpeg.DecodeConfig(bytes.NewReader(jpg)); err != nil || cfg.Width != decoded.width || cfg.Height != decoded.height {
		t.Fatalf("wrong JPEG size: %+v, %v", cfg, err)
	}
}

func TestVisionRecognizesSyntheticText(t *testing.T) {
	decoded := renderAndDecodeTestPicture(t)
	jpg, err := snapshotJPEG(decoded)
	if err != nil {
		t.Fatal(err)
	}
	width, height := decoded.width, decoded.height
	for _, fn := range []struct {
		name string
		run  func() ([]OCRBox, error)
	}{
		{"RGBA", func() ([]OCRBox, error) { return RecognizeTextRGBA(context.Background(), decoded.rgba, width, height) }},
		{"JPEG", func() ([]OCRBox, error) { return RecognizeTextJPEG(context.Background(), jpg) }},
	} {
		t.Run(fn.name, func(t *testing.T) {
			boxes, err := fn.run()
			if err != nil {
				t.Fatal(err)
			}
			for _, box := range boxes {
				if strings.EqualFold(box.Text, syntheticText) && box.Confidence >= .50 &&
					box.X >= 20 && box.X < 50 && box.Y > 45 && box.Y < 100 &&
					box.Width > 300 && box.X+box.Width <= float64(width) && box.Height > 15 {
					return
				}
			}
			t.Fatal("synthetic text missing or reported outside expected pixel bounds")
		})
	}
}

func TestVisionHonorsCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := RecognizeTextRGBA(ctx, []byte{0, 0, 0, 255}, 1, 1); !errors.Is(err, context.Canceled) {
		t.Fatalf("got %v, want canceled", err)
	}
}
