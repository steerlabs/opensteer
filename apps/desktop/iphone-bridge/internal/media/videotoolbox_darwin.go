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
int os_decoder_configure(OSVideoDecoder **, int, const uint8_t *, size_t);
int os_decode(OSVideoDecoder *, const uint8_t *, size_t, uint8_t **, int *, int *);
int os_encode(OSVideoEncoder **, const uint8_t *, int, int, int, uint64_t, int, uint8_t **, size_t *, int *);
void os_wipe_free(void *, size_t);
*/
import "C"

import (
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"unsafe"
)

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
	var out *C.uint8_t
	var width, height C.int
	status := C.os_decode(d.session, cBytes(sample), C.size_t(len(sample)), &out, &width, &height)
	if status != 0 {
		return decodedPicture{}, fmt.Errorf("VideoToolbox decode: %d", status)
	}
	if out == nil {
		return decodedPicture{}, nil
	}
	size := int(width) * int(height) * 4
	defer C.os_wipe_free(unsafe.Pointer(out), C.size_t(size))
	return decodedPicture{C.GoBytes(unsafe.Pointer(out), C.int(size)), int(width), int(height)}, nil
}

func (e *vtEncoder) close() {
	C.os_encoder_close(e.session)
	e.session = nil
}

func (e *vtEncoder) encode(picture decodedPicture, fps int, ptsUs uint64, force bool) (encodedPicture, error) {
	width, height := picture.width, picture.height
	if !validDimensions(width, height) || width%2 != 0 || height%2 != 0 ||
		max(width, height) > 1920 || len(picture.rgba) != width*height*4 || fps < 1 || fps > 60 {
		return encodedPicture{}, errors.New("invalid VideoToolbox encoder input")
	}
	var out *C.uint8_t
	var size C.size_t
	var key C.int
	status := C.os_encode(&e.session, cBytes(picture.rgba), C.int(width), C.int(height),
		C.int(fps), C.uint64_t(ptsUs), boolInt(force), &out, &size, &key)
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
