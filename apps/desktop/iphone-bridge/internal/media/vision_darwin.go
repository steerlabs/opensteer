//go:build darwin && cgo

package media

/*
#cgo LDFLAGS: -framework Vision -framework CoreGraphics -framework ImageIO
#include <stddef.h>
#include <stdint.h>

void *os_vision_request(void);
void os_vision_cancel(void *);
void os_vision_release(void *);
int os_vision_recognize(void *, const uint8_t *, size_t, int, int, uint8_t **, size_t *);
void os_wipe_free(void *, size_t);
*/
import "C"

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"time"
	"unsafe"
)

var visionWorker = make(chan struct{}, 1)

func RecognizeTextRGBA(ctx context.Context, rgba []byte, width, height int) ([]OCRBox, error) {
	if !validDimensions(width, height) || len(rgba) != width*height*4 {
		return nil, errors.New("invalid Vision RGBA image")
	}
	return recognize(ctx, rgba, width, height)
}

func RecognizeTextJPEG(ctx context.Context, jpegBytes []byte) ([]OCRBox, error) {
	if len(jpegBytes) < 3 || len(jpegBytes) > 8*1024*1024 ||
		jpegBytes[0] != 0xff || jpegBytes[1] != 0xd8 || jpegBytes[2] != 0xff {
		return nil, errors.New("invalid Vision JPEG image")
	}
	return recognize(ctx, jpegBytes, 0, 0)
}

func recognize(ctx context.Context, data []byte, width, height int) ([]OCRBox, error) {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	select {
	case visionWorker <- struct{}{}:
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	if err := ctx.Err(); err != nil {
		<-visionWorker
		return nil, err
	}
	request := C.os_vision_request()
	if request == nil {
		<-visionWorker
		return nil, ErrVisionUnavailable
	}
	input := bytes.Clone(data)
	type result struct {
		boxes []OCRBox
		err   error
	}
	completed := make(chan result)
	// The caller retains the request until the worker has finished with it.
	// The worker releases it after publishing a result or observing cancellation.
	callerDone := make(chan struct{})
	go func() {
		defer func() {
			<-callerDone
			C.os_vision_release(request)
			<-visionWorker
		}()
		var out *C.uint8_t
		var size C.size_t
		status := C.os_vision_recognize(request, cBytes(input), C.size_t(len(input)), C.int(width), C.int(height), &out, &size)
		clear(input)
		var parsed result
		if status != 0 {
			parsed.err = errors.New("Vision recognition failed")
		} else {
			parsed.err = json.Unmarshal(unsafe.Slice((*byte)(unsafe.Pointer(out)), int(size)), &parsed.boxes)
		}
		C.os_wipe_free(unsafe.Pointer(out), size)
		select {
		case completed <- parsed:
		case <-ctx.Done():
		}
	}()
	select {
	case got := <-completed:
		close(callerDone)
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		return got.boxes, got.err
	case <-ctx.Done():
		go func() {
			C.os_vision_cancel(request)
			close(callerDone)
		}()
		return nil, ctx.Err()
	}
}
