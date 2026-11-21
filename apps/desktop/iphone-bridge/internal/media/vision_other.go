//go:build !darwin || !cgo

package media

import "context"

func RecognizeTextRGBA(ctx context.Context, rgba []byte, width, height int) ([]OCRBox, error) {
	return nil, ErrVisionUnavailable
}

func RecognizeTextJPEG(ctx context.Context, jpegBytes []byte) ([]OCRBox, error) {
	return nil, ErrVisionUnavailable
}
