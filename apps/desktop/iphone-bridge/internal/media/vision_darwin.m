//go:build darwin && cgo

#import <Foundation/Foundation.h>
#import <Vision/Vision.h>
#import <ImageIO/ImageIO.h>

void *os_vision_request(void) {
    @autoreleasepool {
        VNRecognizeTextRequest *request = [[VNRecognizeTextRequest alloc] initWithCompletionHandler:nil];
        // Fast recognition runs in ~15-150ms on crisp iOS UI text and avoids
        // Accurate-level ANE model compilation hangs in non-GUI helper processes.
        request.recognitionLevel = VNRequestTextRecognitionLevelFast;
        request.usesLanguageCorrection = NO;
        return (__bridge void *)request;
    }
}

void os_vision_cancel(void *raw) {
    @autoreleasepool {
        [(__bridge VNRequest *)raw cancel];
    }
}

void os_vision_release(void *raw) {
    @autoreleasepool {
        [(__bridge VNRequest *)raw release];
    }
}

void os_wipe_free(void *, size_t);

static void release_pixels(void *info, const void *bytes, size_t length) {
    os_wipe_free((void *)bytes, length);
}

static CGImageRef rgba_image(const uint8_t *bytes, size_t length, int width, int height) {
    uint8_t *copy = malloc(length);
    if (!copy) return NULL;
    memcpy(copy, bytes, length);
    CGDataProviderRef provider = CGDataProviderCreateWithData(NULL, copy, length, release_pixels);
    if (!provider) {
        os_wipe_free(copy, length);
        return NULL;
    }
    CGColorSpaceRef color = CGColorSpaceCreateDeviceRGB();
    CGImageRef image = color
        ? CGImageCreate(width, height, 8, 32, width*4, color,
                        kCGBitmapByteOrder32Big | kCGImageAlphaLast,
                        provider, NULL, false, kCGRenderingIntentDefault)
        : NULL;
    if (color) CGColorSpaceRelease(color);
    CGDataProviderRelease(provider);
    return image;
}

static CGImageRef jpeg_image(const uint8_t *bytes, size_t length) {
    uint8_t *copy = malloc(length);
    if (!copy) return NULL;
    memcpy(copy, bytes, length);
    NSData *data = [[[NSData alloc] initWithBytesNoCopy:copy length:length
        deallocator:^(void *buffer, NSUInteger size) { os_wipe_free(buffer, size); }] autorelease];
    CGImageSourceRef source = CGImageSourceCreateWithData((__bridge CFDataRef)data, NULL);
    if (!source) return NULL;
    NSDictionary *props = [(NSDictionary *)CGImageSourceCopyPropertiesAtIndex(source, 0, NULL) autorelease];
    NSInteger width = [props[(__bridge NSString *)kCGImagePropertyPixelWidth] integerValue];
    NSInteger height = [props[(__bridge NSString *)kCGImagePropertyPixelHeight] integerValue];
    CGImageRef image = width > 0 && height > 0 && width <= 4096 && height <= 4096
        ? CGImageSourceCreateImageAtIndex(source, 0, NULL) : NULL;
    CFRelease(source);
    return image;
}

int os_vision_recognize(void *raw, const uint8_t *bytes, size_t length, int width, int height,
                       uint8_t **out, size_t *size) {
    @autoreleasepool {
        VNRecognizeTextRequest *request = (__bridge VNRecognizeTextRequest *)raw;
        CGImageRef image = width ? rgba_image(bytes, length, width, height) : jpeg_image(bytes, length);
        if (!image) return -1;
        double w = CGImageGetWidth(image), h = CGImageGetHeight(image);
        VNImageRequestHandler *handler = [[[VNImageRequestHandler alloc] initWithCGImage:image options:@{}] autorelease];
        CGImageRelease(image);
        if (![handler performRequests:@[request] error:NULL]) return -1;
        NSMutableArray *boxes = [NSMutableArray array];
        for (VNRecognizedTextObservation *observation in request.results) {
            VNRecognizedText *candidate = [observation topCandidates:1].firstObject;
            // VNRequestTextRecognitionLevelFast emits discrete confidence tiers (0.3 / 0.5 / 1.0).
            if (candidate.confidence < 0.50 || candidate.string.length == 0) continue;
            CGRect box = observation.boundingBox;
            [boxes addObject:@{@"Text": candidate.string,
                               @"X": @(CGRectGetMinX(box)*w), @"Y": @((1-CGRectGetMaxY(box))*h),
                               @"Width": @(CGRectGetWidth(box)*w), @"Height": @(CGRectGetHeight(box)*h),
                               @"Confidence": @(candidate.confidence)}];
        }
        NSData *json = [NSJSONSerialization dataWithJSONObject:boxes options:0 error:NULL];
        if (!json) return -1;
        *size = json.length;
        *out = malloc(*size);
        if (!*out) return -1;
        [json getBytes:*out length:*size];
        return 0;
    }
}
