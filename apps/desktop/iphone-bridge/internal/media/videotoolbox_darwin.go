//go:build darwin && cgo

package media

/*
#cgo LDFLAGS: -framework Foundation -framework CoreMedia -framework CoreVideo -framework VideoToolbox
#include <stdlib.h>
#include <stdint.h>

typedef struct OSVideoDecoder OSVideoDecoder;
typedef struct OSVideoEncoder OSVideoEncoder;
void os_decoder_close(OSVideoDecoder *);
void os_encoder_close(OSVideoEncoder *);
void os_pixel_buffer_retain(void *);
void os_pixel_buffer_release(void *);
int os_decoder_configure(OSVideoDecoder **, int, const uint8_t *, size_t);
int os_decode_surface(OSVideoDecoder *, const uint8_t *, size_t, void **, int *, int *);
int os_surface_to_rgba(void *, int, int, uint8_t **);
int os_encode_surface(OSVideoEncoder **, void *, int, int, int, uint64_t, int, uint8_t **, size_t *, int *);
int os_encode(OSVideoEncoder **, const uint8_t *, int, int, int, uint64_t, int, uint8_t **, size_t *, int *);
void os_wipe_free(void *, size_t);
*/
import "C"

import (
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"sync"
	"unsafe"
)

// vtSurface wraps a reference-counted CoreVideo CVPixelBufferRef so decoded
// GPU frames can be retained by the latest-frame mailbox and encoded directly
// via VideoToolbox without ever reading pixels back to CPU memory.
type vtSurface struct {
	mu   sync.Mutex
	buf  unsafe.Pointer
	refs int
}

func newVTSurface(buf unsafe.Pointer) *vtSurface {
	return &vtSurface{buf: buf, refs: 1}
}

func (s *vtSurface) retain() pictureSurface {
	if s == nil {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.buf == nil || s.refs <= 0 {
		return nil
	}
	s.refs++
	return s
}

func (s *vtSurface) release() {
	if s == nil {
		return
	}
	s.mu.Lock()
	if s.refs <= 0 {
		s.mu.Unlock()
		return
	}
	s.refs--
	var drop unsafe.Pointer
	if s.refs == 0 {
		drop = s.buf
		s.buf = nil
	}
	s.mu.Unlock()
	if drop != nil {
		C.os_pixel_buffer_release(drop)
	}
}

func (s *vtSurface) pointer() unsafe.Pointer {
	if s == nil {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.refs <= 0 {
		return nil
	}
	return s.buf
}

func (s *vtSurface) toRGBA(width, height int) ([]byte, error) {
	if s == nil {
		return nil, errors.New("missing VideoToolbox pixel surface")
	}
	if !validDimensions(width, height) {
		return nil, errors.New("invalid VideoToolbox target dimensions")
	}
	// Pin the underlying CVPixelBuffer while C reads it so a concurrent
	// privacy release cannot drop the last ref mid-transfer.
	if s.retain() == nil {
		return nil, errors.New("released VideoToolbox pixel surface")
	}
	defer s.release()
	ptr := s.pointer()
	if ptr == nil {
		return nil, errors.New("released VideoToolbox pixel surface")
	}
	var out *C.uint8_t
	status := C.os_surface_to_rgba(ptr, C.int(width), C.int(height), &out)
	if status != 0 {
		return nil, fmt.Errorf("VideoToolbox surface conversion: %d", status)
	}
	if out == nil {
		return nil, errors.New("VideoToolbox returned no RGBA pixels")
	}
	size := width * height * 4
	defer C.os_wipe_free(unsafe.Pointer(out), C.size_t(size))
	return C.GoBytes(unsafe.Pointer(out), C.int(size)), nil
}

type vtDecoder struct {
	session *C.OSVideoDecoder
	codec   string
}

type vtEncoder struct {
	session *C.OSVideoEncoder
}

func nativeCodecs() (codecFactory, error) {
	return codecFactory{
		decoder: func() videoDecoder { return &vtDecoder{} },
		encoder: func() videoEncoder { return &vtEncoder{} },
	}, nil
}

func (d *vtDecoder) close() {
	C.os_decoder_close(d.session)
	d.session = nil
	d.codec = ""
}

func (d *vtDecoder) decode(unit accessUnit, codec string) (decodedPicture, error) {
	hevc := codec == "hevc"
	var sample, params []byte
	for _, nal := range annexNALs(unit.annexB) {
		isParam := nal[0]&31 == 7 || nal[0]&31 == 8
		if hevc {
			kind := nal[0] >> 1 & 63
			isParam = kind >= 32 && kind <= 34
		}
		if isParam {
			params = binary.BigEndian.AppendUint32(params, uint32(len(nal)))
			params = append(params, nal...)
		} else {
			sample = binary.BigEndian.AppendUint32(sample, uint32(len(nal)))
			sample = append(sample, nal...)
		}
	}
	defer clear(sample)
	defer clear(params)
	if unit.key && len(params) != 0 {
		status := C.os_decoder_configure(&d.session, boolInt(hevc), cBytes(params), C.size_t(len(params)))
		if status != 0 {
			return decodedPicture{}, fmt.Errorf("VideoToolbox decoder setup: %d", status)
		}
		d.codec = codec
	}
	if d.session == nil || d.codec != codec || len(sample) == 0 {
		return decodedPicture{}, errors.New("VideoToolbox needs a configured keyframe")
	}
	var surface unsafe.Pointer
	var width, height C.int
	status := C.os_decode_surface(d.session, cBytes(sample), C.size_t(len(sample)), &surface, &width, &height)
	if status != 0 {
		return decodedPicture{}, fmt.Errorf("VideoToolbox decode: %d", status)
	}
	if surface == nil {
		return decodedPicture{}, nil
	}
	return decodedPicture{surface: newVTSurface(surface), width: int(width), height: int(height)}, nil
}

func (e *vtEncoder) close() {
	C.os_encoder_close(e.session)
	e.session = nil
}

func (e *vtEncoder) encode(picture decodedPicture, width, height, fps int, ptsUs uint64, force bool) (encodedPicture, error) {
	if !validDimensions(width, height) || width%2 != 0 || height%2 != 0 ||
		max(width, height) > 1920 || fps < 1 || fps > 60 {
		return encodedPicture{}, errors.New("invalid VideoToolbox encoder input")
	}
	var out *C.uint8_t
	var size C.size_t
	var key C.int
	var status C.int
	if surf, ok := picture.surface.(*vtSurface); ok && surf != nil {
		if surf.retain() == nil {
			return encodedPicture{}, errors.New("released VideoToolbox surface")
		}
		ptr := surf.pointer()
		if ptr == nil {
			surf.release()
			return encodedPicture{}, errors.New("released VideoToolbox surface")
		}
		status = C.os_encode_surface(&e.session, ptr, C.int(width), C.int(height),
			C.int(fps), C.uint64_t(ptsUs), boolInt(force), &out, &size, &key)
		surf.release()
	} else {
		scaled := scalePicture(picture, width, height)
		if len(scaled.rgba) != width*height*4 {
			if scaled.width != picture.width || scaled.height != picture.height {
				clear(scaled.rgba)
			}
			return encodedPicture{}, errors.New("invalid VideoToolbox encoder RGBA input")
		}
		status = C.os_encode(&e.session, cBytes(scaled.rgba), C.int(width), C.int(height),
			C.int(fps), C.uint64_t(ptsUs), boolInt(force), &out, &size, &key)
		if scaled.width != picture.width || scaled.height != picture.height {
			clear(scaled.rgba)
		}
	}
	if status != 0 {
		return encodedPicture{}, fmt.Errorf("VideoToolbox encode: %d", status)
	}
	if out == nil {
		return encodedPicture{}, errors.New("VideoToolbox returned no encoded frame")
	}
	defer C.os_wipe_free(unsafe.Pointer(out), size)
	if size > maxFramePayload {
		return encodedPicture{}, errors.New("VideoToolbox access unit exceeds frame bound")
	}

	avcc := unsafe.Slice((*byte)(unsafe.Pointer(out)), int(size))
	result := encodedPicture{annexB: make([]byte, 0, int(size)), key: key != 0}
	var pps, idr bool
	for len(avcc) >= 4 {
		n := int(binary.BigEndian.Uint32(avcc))
		avcc = avcc[4:]
		if n < 1 || n > len(avcc) {
			clear(result.annexB)
			return encodedPicture{}, errors.New("invalid VideoToolbox NAL length")
		}
		nal := avcc[:n]
		avcc = avcc[n:]
		switch nal[0] & 31 {
		case 7:
			if result.key && len(nal) >= 4 {
				result.codec = "avc1." + hex.EncodeToString(nal[1:4])
			}
		case 8:
			pps = true
		case 5:
			idr = true
		}
		result.annexB = append(result.annexB, startCode...)
		result.annexB = append(result.annexB, nal...)
	}
	if len(avcc) != 0 || len(result.annexB) == 0 || result.key != idr ||
		(result.key && (result.codec == "" || !pps)) {
		clear(result.annexB)
		return encodedPicture{}, errors.New("invalid VideoToolbox H.264 access unit")
	}
	return result, nil
}

func cBytes(data []byte) *C.uint8_t {
	return (*C.uint8_t)(unsafe.Pointer(unsafe.SliceData(data)))
}

func boolInt(value bool) C.int {
	if value {
		return 1
	}
	return 0
}
