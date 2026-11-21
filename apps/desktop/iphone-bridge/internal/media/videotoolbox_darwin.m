//go:build darwin && cgo

#import <Foundation/Foundation.h>
#import <VideoToolbox/VideoToolbox.h>
#include <arpa/inet.h>

#define MAX_DIMENSION 4096
#define MAX_ACCESS_UNIT (4 * 1024 * 1024)

typedef struct OSVideoDecoder {
    VTDecompressionSessionRef session;
    CMVideoFormatDescriptionRef format;
} OSVideoDecoder;

typedef struct OSVideoEncoder {
    VTCompressionSessionRef session;
    int width, height, fps;
} OSVideoEncoder;

typedef struct {
    CVPixelBufferRef pixels;
    OSStatus status;
} DecodeResult;

typedef struct {
    CMSampleBufferRef sample;
    OSStatus status;
} EncodeResult;

void os_wipe_free(void *data, size_t size) {
    if (data) {
        memset_s(data, size, 0, size);
        free(data);
    }
}

void os_decoder_close(OSVideoDecoder *decoder) {
    if (!decoder) return;
    if (decoder->session) {
        VTDecompressionSessionInvalidate(decoder->session);
        CFRelease(decoder->session);
    }
    if (decoder->format) CFRelease(decoder->format);
    free(decoder);
}

void os_encoder_close(OSVideoEncoder *encoder) {
    if (!encoder) return;
    if (encoder->session) {
        VTCompressionSessionInvalidate(encoder->session);
        CFRelease(encoder->session);
    }
    free(encoder);
}

static void receive_pixels(void *ref, void *frame, OSStatus status, VTDecodeInfoFlags flags,
                           CVImageBufferRef pixels, CMTime pts, CMTime duration) {
    DecodeResult *result = frame;
    result->status = status;
    if (status == noErr && pixels) result->pixels = CVPixelBufferRetain(pixels);
}

int os_decoder_configure(OSVideoDecoder **current, int hevc, const uint8_t *param, size_t length) {
    @autoreleasepool {
        const uint8_t *sets[3];
        size_t sizes[3];
        size_t count = hevc ? 3 : 2;
        for (size_t i = 0; i < count; i++) {
            uint32_t size;
            if (length < sizeof(size)) return paramErr;
            memcpy(&size, param, sizeof(size));
            sizes[i] = ntohl(size);
            param += sizeof(size);
            length -= sizeof(size);
            if (sizes[i] == 0 || sizes[i] > length) return paramErr;
            sets[i] = param;
            param += sizes[i];
            length -= sizes[i];
        }
        if (length != 0) return paramErr;

        CMVideoFormatDescriptionRef format = NULL;
        OSStatus status = hevc
            ? CMVideoFormatDescriptionCreateFromHEVCParameterSets(NULL, count, sets, sizes, 4, NULL, &format)
            : CMVideoFormatDescriptionCreateFromH264ParameterSets(NULL, count, sets, sizes, 4, &format);
        if (status != noErr) return status;
        CMVideoDimensions size = CMVideoFormatDescriptionGetDimensions(format);
        if (size.width < 1 || size.height < 1 || size.width > MAX_DIMENSION || size.height > MAX_DIMENSION) {
            CFRelease(format);
            return paramErr;
        }
        if (*current && CMFormatDescriptionEqual((*current)->format, format)) {
            CFRelease(format);
            return noErr;
        }
        os_decoder_close(*current);
        *current = NULL;

        OSVideoDecoder *decoder = calloc(1, sizeof(*decoder));
        if (!decoder) {
            CFRelease(format);
            return memFullErr;
        }
        decoder->format = format;
        NSDictionary *spec = @{(__bridge NSString *)kVTVideoDecoderSpecification_RequireHardwareAcceleratedVideoDecoder: @YES};
        NSDictionary *attrs = @{(__bridge NSString *)kCVPixelBufferPixelFormatTypeKey: @(kCVPixelFormatType_32BGRA)};
        VTDecompressionOutputCallbackRecord callback = {receive_pixels, NULL};
        status = VTDecompressionSessionCreate(NULL, format, (__bridge CFDictionaryRef)spec,
                                              (__bridge CFDictionaryRef)attrs, &callback, &decoder->session);
        if (status != noErr) {
            os_decoder_close(decoder);
            return status;
        }
        *current = decoder;
        return noErr;
    }
}

int os_decode(OSVideoDecoder *decoder, const uint8_t *data, size_t size,
              uint8_t **rgba, int *width, int *height) {
    @autoreleasepool {
        CMBlockBufferRef block = NULL;
        CMSampleBufferRef sample = NULL;
        DecodeResult result = {0};
        OSStatus status = CMBlockBufferCreateWithMemoryBlock(NULL, NULL, size, NULL, NULL, 0, size,
                                                             kCMBlockBufferAssureMemoryNowFlag, &block);
        if (status == noErr) status = CMBlockBufferReplaceDataBytes(data, block, 0, size);
        if (status == noErr) {
            status = CMSampleBufferCreateReady(NULL, block, decoder->format, 1, 0, NULL, 1, &size, &sample);
        }
        if (status == noErr) {
            status = VTDecompressionSessionDecodeFrame(decoder->session, sample, 0, &result, NULL);
            OSStatus waitStatus = VTDecompressionSessionWaitForAsynchronousFrames(decoder->session);
            if (status == noErr) status = waitStatus;
        }
        if (sample) CFRelease(sample);
        if (block) CFRelease(block);
        if (status == noErr) status = result.status;
        CVPixelBufferRef pixels = result.pixels;
        if (!pixels) return status;
        if (status == noErr) {
            size_t w = CVPixelBufferGetWidth(pixels), h = CVPixelBufferGetHeight(pixels);
            if (w < 1 || h < 1 || w > MAX_DIMENSION || h > MAX_DIMENSION ||
                CVPixelBufferGetPixelFormatType(pixels) != kCVPixelFormatType_32BGRA) {
                status = paramErr;
            } else {
                status = CVPixelBufferLockBaseAddress(pixels, kCVPixelBufferLock_ReadOnly);
                if (status == noErr) {
                    const uint8_t *base = CVPixelBufferGetBaseAddress(pixels);
                    size_t stride = CVPixelBufferGetBytesPerRow(pixels);
                    uint8_t *dst = malloc(w*h*4);
                    if (dst) {
                        for (size_t y = 0; y < h; y++) {
                            for (size_t x = 0; x < w; x++) {
                                const uint8_t *src = base + y*stride + x*4;
                                uint8_t *pixel = dst + (y*w+x)*4;
                                pixel[0] = src[2];
                                pixel[1] = src[1];
                                pixel[2] = src[0];
                                pixel[3] = 255;
                            }
                        }
                        *rgba = dst;
                        *width = (int)w;
                        *height = (int)h;
                    } else {
                        status = memFullErr;
                    }
                    CVPixelBufferUnlockBaseAddress(pixels, kCVPixelBufferLock_ReadOnly);
                }
            }
        }
        CVPixelBufferRelease(pixels);
        return status;
    }
}

static void receive_sample(void *ref, void *frame, OSStatus status, VTEncodeInfoFlags flags,
                           CMSampleBufferRef sample) {
    EncodeResult *result = frame;
    result->status = status;
    if (status == noErr && sample && CMSampleBufferDataIsReady(sample)) {
        result->sample = (CMSampleBufferRef)CFRetain(sample);
    }
}

static OSStatus configure_encoder(OSVideoEncoder **current, int width, int height, int fps) {
    OSVideoEncoder *encoder = *current;
    if (encoder && encoder->width == width && encoder->height == height && encoder->fps == fps) return noErr;
    os_encoder_close(encoder);
    *current = NULL;
    encoder = calloc(1, sizeof(*encoder));
    if (!encoder) return memFullErr;

    NSDictionary *spec = @{(__bridge NSString *)kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder: @YES};
    NSDictionary *attrs = @{(__bridge NSString *)kCVPixelBufferPixelFormatTypeKey: @(kCVPixelFormatType_32BGRA)};
    OSStatus status = VTCompressionSessionCreate(NULL, width, height, kCMVideoCodecType_H264,
                                                 (__bridge CFDictionaryRef)spec, (__bridge CFDictionaryRef)attrs,
                                                 NULL, receive_sample, NULL, &encoder->session);
    if (status == noErr) {
        int bitrate = MAX(300000, MIN(6000000, width*height*fps/5));
        NSDictionary *properties = @{
            (__bridge NSString *)kVTCompressionPropertyKey_RealTime: @YES,
            (__bridge NSString *)kVTCompressionPropertyKey_AllowFrameReordering: @NO,
            (__bridge NSString *)kVTCompressionPropertyKey_ExpectedFrameRate: @(fps),
            (__bridge NSString *)kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration: @2,
            (__bridge NSString *)kVTCompressionPropertyKey_AverageBitRate: @(bitrate),
            (__bridge NSString *)kVTCompressionPropertyKey_ProfileLevel: (__bridge NSString *)kVTProfileLevel_H264_High_AutoLevel
        };
        status = VTSessionSetProperties(encoder->session, (__bridge CFDictionaryRef)properties);
    }
    if (status == noErr) status = VTCompressionSessionPrepareToEncodeFrames(encoder->session);
    if (status != noErr) {
        os_encoder_close(encoder);
        return status;
    }
    encoder->width = width;
    encoder->height = height;
    encoder->fps = fps;
    *current = encoder;
    return noErr;
}

static OSStatus copy_h264_sample(CMSampleBufferRef sample, uint8_t **out, size_t *size, int *key) {
    CFArrayRef attachments = CMSampleBufferGetSampleAttachmentsArray(sample, false);
    CFDictionaryRef first = attachments && CFArrayGetCount(attachments) != 0
        ? CFArrayGetValueAtIndex(attachments, 0) : NULL;
    *key = !first || !CFDictionaryContainsKey(first, kCMSampleAttachmentKey_NotSync);
    CMBlockBufferRef buffer = CMSampleBufferGetDataBuffer(sample);
    if (!buffer) return paramErr;
    size_t length = CMBlockBufferGetDataLength(buffer);
    const uint8_t *params[2];
    size_t lengths[2];
    size_t prefix = 0;
    if (*key) {
        CMFormatDescriptionRef format = CMSampleBufferGetFormatDescription(sample);
        for (size_t i = 0; i < 2; i++) {
            int headerLength = 0;
            OSStatus status = CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
                format, i, &params[i], &lengths[i], NULL, &headerLength);
            if (status != noErr) return status;
            if (headerLength != 4 || lengths[i] > 65535) return paramErr;
            prefix += 4 + lengths[i];
        }
    }
    if (length == 0 || length > MAX_ACCESS_UNIT - prefix) return paramErr;
    uint8_t *bytes = malloc(prefix + length);
    if (!bytes) return memFullErr;
    size_t offset = 0;
    if (*key) {
        for (size_t i = 0; i < 2; i++) {
            uint32_t n = htonl((uint32_t)lengths[i]);
            memcpy(bytes+offset, &n, 4);
            offset += 4;
            memcpy(bytes+offset, params[i], lengths[i]);
            offset += lengths[i];
        }
    }
    OSStatus status = CMBlockBufferCopyDataBytes(buffer, 0, length, bytes+prefix);
    if (status != noErr) {
        os_wipe_free(bytes, prefix+length);
        return status;
    }
    *out = bytes;
    *size = prefix + length;
    return noErr;
}

static void wipe_pixel_buffer(void *releaseRefCon, const void *baseAddress) {
    os_wipe_free((void *)baseAddress, (size_t)(uintptr_t)releaseRefCon);
}

int os_encode(OSVideoEncoder **current, const uint8_t *rgba, int width, int height, int fps,
              uint64_t pts, int force, uint8_t **out, size_t *size, int *key) {
    @autoreleasepool {
        OSStatus status = configure_encoder(current, width, height, fps);
        if (status != noErr) return status;
        VTCompressionSessionRef session = (*current)->session;
        size_t stride = (((size_t)width * 4) + 63) & ~(size_t)63;
        size_t totalSize = stride * (size_t)height;
        uint8_t *base = calloc(1, totalSize);
        if (!base) return memFullErr;
        for (int y = 0; y < height; y++) {
            for (int x = 0; x < width; x++) {
                const uint8_t *src = rgba + ((size_t)y*width+x)*4;
                uint8_t *dst = base + (size_t)y*stride + (size_t)x*4;
                dst[0] = src[2];
                dst[1] = src[1];
                dst[2] = src[0];
                dst[3] = 255;
            }
        }
        CVPixelBufferRef pixels = NULL;
        status = CVPixelBufferCreateWithBytes(
            NULL, (size_t)width, (size_t)height, kCVPixelFormatType_32BGRA,
            base, stride, wipe_pixel_buffer, (void *)(uintptr_t)totalSize, NULL, &pixels);
        if (status != noErr) {
            os_wipe_free(base, totalSize);
            return status;
        }
        NSDictionary *options = force ? @{(__bridge NSString *)kVTEncodeFrameOptionKey_ForceKeyFrame: @YES} : nil;
        EncodeResult result = {0};
        status = VTCompressionSessionEncodeFrame(session, pixels, CMTimeMake(pts, 1000000),
                                                 CMTimeMake(1, fps), (__bridge CFDictionaryRef)options, &result, NULL);
        CVPixelBufferRelease(pixels);
        OSStatus waitStatus = VTCompressionSessionCompleteFrames(session, kCMTimeInvalid);
        if (status == noErr) status = waitStatus;
        if (status == noErr) status = result.status;
        if (result.sample) {
            if (status == noErr) status = copy_h264_sample(result.sample, out, size, key);
            CFRelease(result.sample);
        }
        return status;
    }
}
