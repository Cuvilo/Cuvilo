#import <Foundation/Foundation.h>
#import <AppKit/AppKit.h>
#import <Vision/Vision.h>
#import <AVFoundation/AVFoundation.h>
#import <CoreMedia/CoreMedia.h>
#import <CoreGraphics/CoreGraphics.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <pthread.h>

typedef void (*MacAudioDataCallback)(const uint8_t *pcm, size_t length, float level, void *context);
typedef void (*MacAudioErrorCallback)(const char *error_message, void *context);

static pthread_mutex_t g_tcc_mutex = PTHREAD_MUTEX_INITIALIZER;

static NSString *current_binary_tcc_key(void) {
    NSBundle *bundle = [NSBundle mainBundle];
    NSString *version = [bundle objectForInfoDictionaryKey:@"CFBundleShortVersionString"] ?: @"0";
    NSString *execPath = [bundle executablePath] ?: @"";
    NSDictionary *attrs = [[NSFileManager defaultManager] attributesOfItemAtPath:execPath error:nil];
    NSDate *mtime = [attrs fileModificationDate];
    unsigned long long size = [attrs fileSize];
    long long ts = mtime ? (long long)[mtime timeIntervalSince1970] : 0;
    return [NSString stringWithFormat:@"%@:%lld:%llu", version, ts, size];
}

static void reset_tcc_service_for_bundle(NSString *service) {
    @try {
        NSString *bundleId = [[NSBundle mainBundle] bundleIdentifier] ?: @"local.interview.copilot";
        NSTask *task = [[NSTask alloc] init];
        [task setLaunchPath:@"/usr/bin/tccutil"];
        [task setArguments:@[@"reset", service, bundleId]];
        [task setStandardOutput:[NSPipe pipe]];
        [task setStandardError:[NSPipe pipe]];
        [task launch];
        [task waitUntilExit];
    } @catch (NSException *exception) {
    }
}

static void ensure_screen_tcc_fresh_for_current_binary(BOOL force_on_denied) {
    pthread_mutex_lock(&g_tcc_mutex);
    NSString *sig = current_binary_tcc_key();
    NSUserDefaults *defaults = [NSUserDefaults standardUserDefaults];
    NSString *prepared = [defaults stringForKey:@"CuviloScreenTCCBinaryKey"];
    if (![sig isEqualToString:prepared]) {
        if (force_on_denied || !CGPreflightScreenCaptureAccess()) {
            [defaults setObject:sig forKey:@"CuviloScreenTCCBinaryKey"];
            [defaults synchronize];
            reset_tcc_service_for_bundle(@"ScreenCapture");
            if (force_on_denied) {
                CGRequestScreenCaptureAccess();
            }
        }
    }
    pthread_mutex_unlock(&g_tcc_mutex);
}

static void ensure_mic_tcc_fresh_for_current_binary(void) {
    pthread_mutex_lock(&g_tcc_mutex);
    NSString *sig = current_binary_tcc_key();
    NSUserDefaults *defaults = [NSUserDefaults standardUserDefaults];
    NSString *prepared = [defaults stringForKey:@"CuviloMicTCCBinaryKey"];
    if (![sig isEqualToString:prepared]) {
        [defaults setObject:sig forKey:@"CuviloMicTCCBinaryKey"];
        [defaults synchronize];
        if (@available(macOS 10.14, *)) {
            AVAuthorizationStatus status = [AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeAudio];
            if (status != AVAuthorizationStatusAuthorized) {
                reset_tcc_service_for_bundle(@"Microphone");
            }
        }
    }
    pthread_mutex_unlock(&g_tcc_mutex);
}

bool mac_has_screen_capture_permission(void) {
    return CGPreflightScreenCaptureAccess();
}

bool mac_request_screen_capture_permission(void) {
    return CGRequestScreenCaptureAccess();
}

void mac_audio_free_string(char *s) {
    if (s) free(s);
}

void mac_activate_and_order_front(void) {
    @autoreleasepool {
        void (^block)(void) = ^{
            [NSApp activateIgnoringOtherApps:YES];
            for (NSWindow *window in [NSApp windows]) {
                if ([window isVisible]) {
                    [window orderFrontRegardless];
                }
            }
        };
        if ([NSThread isMainThread]) {
            block();
        } else {
            dispatch_async(dispatch_get_main_queue(), block);
        }
    }
}

char *mac_ocr_recognize_png(const uint8_t *png_bytes, size_t png_len, char **error_out) {
    @autoreleasepool {
        if (!png_bytes || png_len == 0) {
            if (error_out) *error_out = strdup("空截图数据");
            return NULL;
        }
        NSData *data = [NSData dataWithBytes:png_bytes length:png_len];
        VNRecognizeTextRequest *request = [[VNRecognizeTextRequest alloc] init];
        request.recognitionLevel = VNRequestTextRecognitionLevelAccurate;
        request.usesLanguageCorrection = YES;
        if (@available(macOS 13.0, *)) {
            request.automaticallyDetectsLanguage = YES;
        }
        NSArray<NSString *> *supported = [request supportedRecognitionLanguagesAndReturnError:nil];
        if (supported.count > 0) {
            NSMutableArray<NSString *> *langs = [NSMutableArray array];
            for (NSString *preferred in @[@"zh-Hans", @"zh-Hant", @"en-US"]) {
                if ([supported containsObject:preferred]) {
                    [langs addObject:preferred];
                }
            }
            if (langs.count > 0) {
                request.recognitionLanguages = langs;
            }
        }
        VNImageRequestHandler *handler = [[VNImageRequestHandler alloc] initWithData:data options:@{}];
        NSError *err = nil;
        if (![handler performRequests:@[request] error:&err]) {
            if (error_out) {
                *error_out = strdup(err ? [[err localizedDescription] UTF8String] : "Apple Vision OCR 识别失败");
            }
            return NULL;
        }
        NSMutableArray<NSString *> *lines = [NSMutableArray array];
        for (VNRecognizedTextObservation *obs in request.results) {
            VNRecognizedText *top = [[obs topCandidates:1] firstObject];
            if (top && top.string.length > 0) {
                [lines addObject:top.string];
            }
        }
        NSString *joined = [lines componentsJoinedByString:@"\n"];
        return strdup([joined UTF8String] ?: "");
    }
}

static void process_audio_sample_buffer(
    CMSampleBufferRef sampleBuffer,
    MacAudioDataCallback data_cb,
    void *context
) {
    if (!CMSampleBufferIsValid(sampleBuffer)) return;
    CMAudioFormatDescriptionRef formatDesc = CMSampleBufferGetFormatDescription(sampleBuffer);
    if (!formatDesc) return;
    const AudioStreamBasicDescription *asbd = CMAudioFormatDescriptionGetStreamBasicDescription(formatDesc);
    if (!asbd) return;
    CMItemCount numSamples = CMSampleBufferGetNumSamples(sampleBuffer);
    if (numSamples <= 0) return;

    size_t bufferListSizeNeeded = 0;
    OSStatus status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
        sampleBuffer,
        &bufferListSizeNeeded,
        NULL,
        0,
        kCFAllocatorDefault,
        kCFAllocatorDefault,
        0,
        NULL
    );
    if (status != noErr || bufferListSizeNeeded == 0) return;

    AudioBufferList *bufferList = (AudioBufferList *)malloc(bufferListSizeNeeded);
    if (!bufferList) return;
    CMBlockBufferRef blockBuffer = NULL;
    status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
        sampleBuffer,
        NULL,
        bufferList,
        bufferListSizeNeeded,
        kCFAllocatorDefault,
        kCFAllocatorDefault,
        0,
        &blockBuffer
    );

    if (status == noErr) {
        UInt32 numBuffers = bufferList->mNumberBuffers;
        UInt32 channels = asbd->mChannelsPerFrame;
        double sampleRate = asbd->mSampleRate;
        BOOL isFloat = (asbd->mFormatFlags & kAudioFormatFlagIsFloat) != 0;
        BOOL isSignedInt = (asbd->mFormatFlags & kAudioFormatFlagIsSignedInteger) != 0;

        if ((isFloat || isSignedInt) && numBuffers > 0) {
            float *mono = (float *)calloc((size_t)numSamples, sizeof(float));
            if (mono) {
                if (isFloat) {
                    if (numBuffers > 1) {
                        float inv = 1.0f / (float)numBuffers;
                        for (UInt32 b = 0; b < numBuffers; b++) {
                            const float *src = (const float *)bufferList->mBuffers[b].mData;
                            size_t avail = bufferList->mBuffers[b].mDataByteSize / sizeof(float);
                            size_t limit = (size_t)numSamples < avail ? (size_t)numSamples : avail;
                            if (src) {
                                for (size_t i = 0; i < limit; i++) {
                                    mono[i] += src[i] * inv;
                                }
                            }
                        }
                    } else if (channels > 1) {
                        const float *src = (const float *)bufferList->mBuffers[0].mData;
                        size_t avail = bufferList->mBuffers[0].mDataByteSize / (sizeof(float) * channels);
                        size_t limit = (size_t)numSamples < avail ? (size_t)numSamples : avail;
                        if (src) {
                            float inv = 1.0f / (float)channels;
                            for (size_t i = 0; i < limit; i++) {
                                float sum = 0.0f;
                                for (UInt32 c = 0; c < channels; c++) {
                                    sum += src[i * channels + c];
                                }
                                mono[i] = sum * inv;
                            }
                        }
                    } else {
                        const float *src = (const float *)bufferList->mBuffers[0].mData;
                        size_t avail = bufferList->mBuffers[0].mDataByteSize / sizeof(float);
                        size_t limit = (size_t)numSamples < avail ? (size_t)numSamples : avail;
                        if (src && limit > 0) {
                            memcpy(mono, src, limit * sizeof(float));
                        }
                    }
                } else if (asbd->mBitsPerChannel == 16) {
                    if (numBuffers > 1) {
                        float inv = 1.0f / ((float)numBuffers * 32768.0f);
                        for (UInt32 b = 0; b < numBuffers; b++) {
                            const int16_t *src = (const int16_t *)bufferList->mBuffers[b].mData;
                            size_t avail = bufferList->mBuffers[b].mDataByteSize / sizeof(int16_t);
                            size_t limit = (size_t)numSamples < avail ? (size_t)numSamples : avail;
                            if (src) {
                                for (size_t i = 0; i < limit; i++) {
                                    mono[i] += (float)src[i] * inv;
                                }
                            }
                        }
                    } else {
                        const int16_t *src = (const int16_t *)bufferList->mBuffers[0].mData;
                        UInt32 ch = channels > 0 ? channels : 1;
                        size_t avail = bufferList->mBuffers[0].mDataByteSize / (sizeof(int16_t) * ch);
                        size_t limit = (size_t)numSamples < avail ? (size_t)numSamples : avail;
                        if (src) {
                            float inv = 1.0f / ((float)ch * 32768.0f);
                            for (size_t i = 0; i < limit; i++) {
                                float sum = 0.0f;
                                for (UInt32 c = 0; c < ch; c++) {
                                    sum += (float)src[i * ch + c];
                                }
                                mono[i] = sum * inv;
                            }
                        }
                    }
                }

                const double target_rate = 16000.0;
                float *resampled = mono;
                size_t out_count = (size_t)numSamples;
                if (fabs(sampleRate - target_rate) > 10.0 && sampleRate > 1000.0) {
                    double step = sampleRate / target_rate;
                    out_count = (size_t)((double)numSamples * (target_rate / sampleRate));
                    if (out_count == 0) out_count = 1;
                    float *temp = (float *)malloc(out_count * sizeof(float));
                    if (temp) {
                        for (size_t i = 0; i < out_count; i++) {
                            double src_pos = (double)i * step;
                            size_t idx0 = (size_t)src_pos;
                            float frac = (float)(src_pos - (double)idx0);
                            size_t idx1 = (idx0 + 1 < (size_t)numSamples) ? idx0 + 1 : (size_t)numSamples - 1;
                            if (idx0 >= (size_t)numSamples) idx0 = (size_t)numSamples - 1;
                            temp[i] = mono[idx0] * (1.0f - frac) + mono[idx1] * frac;
                        }
                        free(mono);
                        resampled = temp;
                    }
                }

                int16_t *int16_buf = (int16_t *)malloc(out_count * sizeof(int16_t));
                float max_peak = 0.0f;
                if (int16_buf) {
                    for (size_t i = 0; i < out_count; i++) {
                        float val = resampled[i];
                        if (val > 1.0f) val = 1.0f;
                        if (val < -1.0f) val = -1.0f;
                        float abs_v = fabsf(val);
                        if (abs_v > max_peak) max_peak = abs_v;
                        int16_buf[i] = (int16_t)(val * 32767.0f);
                    }
                    if (data_cb) {
                        data_cb((const uint8_t *)int16_buf, out_count * sizeof(int16_t), max_peak, context);
                    }
                    free(int16_buf);
                }
                free(resampled);
            }
        }
    }
    if (blockBuffer) {
        CFRelease(blockBuffer);
    }
    free(bufferList);
}

@interface CuviloSystemCaptureSession : NSObject <SCStreamOutput, SCStreamDelegate>
@property (nonatomic, strong) SCStream *stream;
@property (nonatomic, assign) MacAudioDataCallback dataCallback;
@property (nonatomic, assign) MacAudioErrorCallback errorCallback;
@property (nonatomic, assign) void *context;
@property (nonatomic, strong) dispatch_queue_t audioQueue;
@property (nonatomic, strong) dispatch_queue_t videoQueue;
@property (nonatomic, assign) BOOL running;
@end

@implementation CuviloSystemCaptureSession

- (void)stream:(SCStream *)stream didOutputSampleBuffer:(CMSampleBufferRef)sampleBuffer ofType:(SCStreamOutputType)type {
    if (type == SCStreamOutputTypeAudio && self.running) {
        process_audio_sample_buffer(sampleBuffer, self.dataCallback, self.context);
    }
}

- (void)stream:(SCStream *)stream didStopWithError:(NSError *)error {
    if (self.running && self.errorCallback) {
        self.running = NO;
        self.errorCallback([[error localizedDescription] UTF8String], self.context);
    }
}

- (void)stop {
    self.running = NO;
    if (self.stream) {
        SCStream *s = self.stream;
        self.stream = nil;
        [s stopCaptureWithCompletionHandler:^(NSError * _Nullable error) {}];
    }
}

@end

void *mac_start_system_audio_capture(
    MacAudioDataCallback data_callback,
    MacAudioErrorCallback error_callback,
    void *context,
    char **error_out
) {
    @autoreleasepool {
        if (@available(macOS 13.0, *)) {
            ensure_screen_tcc_fresh_for_current_binary(NO);

            dispatch_semaphore_t sem = dispatch_semaphore_create(0);
            __block SCShareableContent *capturedContent = nil;
            __block NSError *contentError = nil;

            [SCShareableContent getShareableContentExcludingDesktopWindows:NO
                                                      onScreenWindowsOnly:YES
                                                        completionHandler:^(SCShareableContent * _Nullable shareableContent, NSError * _Nullable error) {
                capturedContent = shareableContent;
                contentError = error;
                dispatch_semaphore_signal(sem);
            }];

            dispatch_time_t timeout = dispatch_time(DISPATCH_TIME_NOW, (int64_t)(30 * NSEC_PER_SEC));
            if (dispatch_semaphore_wait(sem, timeout) != 0 || !capturedContent) {
                if (contentError) {
                    NSInteger code = contentError.code;
                    NSString *desc = [contentError localizedDescription];
                    if (code == -3801 || (desc && ([desc localizedCaseInsensitiveContainsString:@"declined"] ||
                                                   [desc localizedCaseInsensitiveContainsString:@"denied"] ||
                                                   [desc localizedCaseInsensitiveContainsString:@"permission"]))) {
                        ensure_screen_tcc_fresh_for_current_binary(YES);
                        if (error_out) {
                            *error_out = strdup("permission_denied");
                        }
                        return NULL;
                    }
                }
                if (error_out) {
                    *error_out = strdup(contentError ? [[contentError localizedDescription] UTF8String] : "ScreenCaptureKit content timeout");
                }
                return NULL;
            }

            SCDisplay *display = capturedContent.displays.firstObject;
            if (!display) {
                if (error_out) {
                    *error_out = strdup("未找到可用显示器");
                }
                return NULL;
            }

            pthread_mutex_lock(&g_tcc_mutex);
            [[NSUserDefaults standardUserDefaults] setObject:current_binary_tcc_key() forKey:@"CuviloScreenTCCBinaryKey"];
            [[NSUserDefaults standardUserDefaults] synchronize];
            pthread_mutex_unlock(&g_tcc_mutex);

            SCContentFilter *filter = [[SCContentFilter alloc] initWithDisplay:display
                                                         excludingApplications:@[]
                                                               exceptingWindows:@[]];

            SCStreamConfiguration *config = [[SCStreamConfiguration alloc] init];
            config.capturesAudio = YES;
            config.excludesCurrentProcessAudio = YES;
            config.channelCount = 2;
            config.sampleRate = 48000;
            config.width = 2;
            config.height = 2;
            config.minimumFrameInterval = CMTimeMake(1, 1);
            config.queueDepth = 3;

            CuviloSystemCaptureSession *session = [[CuviloSystemCaptureSession alloc] init];
            session.dataCallback = data_callback;
            session.errorCallback = error_callback;
            session.context = context;
            session.running = YES;
            session.audioQueue = dispatch_queue_create("cuvilo.audio.capture", DISPATCH_QUEUE_SERIAL);
            session.videoQueue = dispatch_queue_create("cuvilo.video.dummy", DISPATCH_QUEUE_SERIAL);

            SCStream *stream = [[SCStream alloc] initWithFilter:filter configuration:config delegate:session];
            [stream addStreamOutput:session type:SCStreamOutputTypeScreen sampleHandlerQueue:session.videoQueue error:nil];
            NSError *addErr = nil;
            [stream addStreamOutput:session type:SCStreamOutputTypeAudio sampleHandlerQueue:session.audioQueue error:&addErr];
            if (addErr) {
                if (error_out) {
                    *error_out = strdup([[addErr localizedDescription] UTF8String]);
                }
                return NULL;
            }

            __block NSError *startErr = nil;
            dispatch_semaphore_t startSem = dispatch_semaphore_create(0);
            [stream startCaptureWithCompletionHandler:^(NSError * _Nullable error) {
                startErr = error;
                dispatch_semaphore_signal(startSem);
            }];

            if (dispatch_semaphore_wait(startSem, timeout) != 0 || startErr) {
                if (startErr) {
                    NSInteger code = startErr.code;
                    NSString *desc = [startErr localizedDescription];
                    if (code == -3801 || (desc && ([desc localizedCaseInsensitiveContainsString:@"declined"] ||
                                                   [desc localizedCaseInsensitiveContainsString:@"denied"] ||
                                                   [desc localizedCaseInsensitiveContainsString:@"permission"]))) {
                        ensure_screen_tcc_fresh_for_current_binary(YES);
                        if (error_out) {
                            *error_out = strdup("permission_denied");
                        }
                        return NULL;
                    }
                }
                if (error_out) {
                    *error_out = strdup(startErr ? [[startErr localizedDescription] UTF8String] : "ScreenCaptureKit start timeout");
                }
                return NULL;
            }

            session.stream = stream;
            return (__bridge_retained void *)session;
        } else {
            if (error_out) {
                *error_out = strdup("macOS 13.0 or higher is required for ScreenCaptureKit");
            }
            return NULL;
        }
    }
}

void mac_stop_system_audio_capture(void *handle) {
    if (!handle) return;
    CuviloSystemCaptureSession *session = (__bridge_transfer CuviloSystemCaptureSession *)handle;
    [session stop];
}

@interface CuviloMicCaptureSession : NSObject
@property (nonatomic, strong) AVAudioEngine *engine;
@property (nonatomic, assign) MacAudioDataCallback dataCallback;
@property (nonatomic, assign) MacAudioErrorCallback errorCallback;
@property (nonatomic, assign) void *context;
@property (nonatomic, assign) BOOL running;
@end

@implementation CuviloMicCaptureSession
- (void)stop {
    self.running = NO;
    if (self.engine) {
        AVAudioEngine *e = self.engine;
        self.engine = nil;
        [[e inputNode] removeTapOnBus:0];
        [e stop];
    }
}
@end

void *mac_start_mic_audio_capture(
    MacAudioDataCallback data_callback,
    MacAudioErrorCallback error_callback,
    void *context,
    char **error_out
) {
    @autoreleasepool {
        @try {
            ensure_mic_tcc_fresh_for_current_binary();
            if (@available(macOS 10.14, *)) {
                pthread_mutex_lock(&g_tcc_mutex);
                AVAuthorizationStatus status = [AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeAudio];
                if (status == AVAuthorizationStatusNotDetermined) {
                    dispatch_semaphore_t sem = dispatch_semaphore_create(0);
                    __block BOOL grantedAccess = NO;
                    [AVCaptureDevice requestAccessForMediaType:AVMediaTypeAudio completionHandler:^(BOOL granted) {
                        grantedAccess = granted;
                        dispatch_semaphore_signal(sem);
                    }];
                    dispatch_time_t waitTime = dispatch_time(DISPATCH_TIME_NOW, (int64_t)(60 * NSEC_PER_SEC));
                    dispatch_semaphore_wait(sem, waitTime);
                    pthread_mutex_unlock(&g_tcc_mutex);
                    if (!grantedAccess) {
                        if (error_out) *error_out = strdup("permission_denied");
                        return NULL;
                    }
                } else if (status == AVAuthorizationStatusDenied || status == AVAuthorizationStatusRestricted) {
                    pthread_mutex_unlock(&g_tcc_mutex);
                    if (error_out) *error_out = strdup("permission_denied");
                    return NULL;
                } else {
                    pthread_mutex_unlock(&g_tcc_mutex);
                }
            }

            AVAudioEngine *engine = [[AVAudioEngine alloc] init];
        AVAudioInputNode *input = [engine inputNode];
        AVAudioFormat *format = [input outputFormatForBus:0];
        if (format.sampleRate <= 0) {
            if (error_out) *error_out = strdup("Invalid microphone format");
            return NULL;
        }

        CuviloMicCaptureSession *session = [[CuviloMicCaptureSession alloc] init];
        session.engine = engine;
        session.dataCallback = data_callback;
        session.errorCallback = error_callback;
        session.context = context;
        session.running = YES;

        [input installTapOnBus:0 bufferSize:1024 format:format block:^(AVAudioPCMBuffer * _Nonnull buffer, AVAudioTime * _Nonnull when) {
            if (!session.running) return;
            const float * const *floatData = buffer.floatChannelData;
            if (!floatData) return;
            size_t frameCount = (size_t)buffer.frameLength;
            size_t channels = (size_t)buffer.format.channelCount;
            if (frameCount == 0 || channels == 0) return;

            float *mono = (float *)calloc(frameCount, sizeof(float));
            if (!mono) return;
            if (channels > 1) {
                float inv = 1.0f / (float)channels;
                for (size_t c = 0; c < channels; c++) {
                    const float *src = floatData[c];
                    for (size_t i = 0; i < frameCount; i++) {
                        mono[i] += src[i] * inv;
                    }
                }
            } else {
                memcpy(mono, floatData[0], frameCount * sizeof(float));
            }

            const double target_rate = 16000.0;
            double sampleRate = buffer.format.sampleRate;
            float *resampled = mono;
            size_t out_count = frameCount;
            if (fabs(sampleRate - target_rate) > 10.0 && sampleRate > 1000.0) {
                double step = sampleRate / target_rate;
                out_count = (size_t)((double)frameCount * (target_rate / sampleRate));
                if (out_count == 0) out_count = 1;
                float *temp = (float *)malloc(out_count * sizeof(float));
                if (temp) {
                    for (size_t i = 0; i < out_count; i++) {
                        double src_pos = (double)i * step;
                        size_t idx0 = (size_t)src_pos;
                        float frac = (float)(src_pos - (double)idx0);
                        size_t idx1 = (idx0 + 1 < frameCount) ? idx0 + 1 : frameCount - 1;
                        if (idx0 >= frameCount) idx0 = frameCount - 1;
                        temp[i] = mono[idx0] * (1.0f - frac) + mono[idx1] * frac;
                    }
                    free(mono);
                    resampled = temp;
                }
            }

            int16_t *int16_buf = (int16_t *)malloc(out_count * sizeof(int16_t));
            float max_peak = 0.0f;
            if (int16_buf) {
                for (size_t i = 0; i < out_count; i++) {
                    float val = resampled[i];
                    if (val > 1.0f) val = 1.0f;
                    if (val < -1.0f) val = -1.0f;
                    float abs_v = fabsf(val);
                    if (abs_v > max_peak) max_peak = abs_v;
                    int16_buf[i] = (int16_t)(val * 32767.0f);
                }
                if (session.dataCallback) {
                    session.dataCallback((const uint8_t *)int16_buf, out_count * sizeof(int16_t), max_peak, session.context);
                }
                free(int16_buf);
            }
            free(resampled);
        }];

        NSError *startErr = nil;
        if (![engine startAndReturnError:&startErr]) {
            if (error_out) *error_out = strdup([[startErr localizedDescription] UTF8String]);
            [session stop];
            return NULL;
        }

            return (__bridge_retained void *)session;
        } @catch (NSException *exception) {
            if (error_out) *error_out = strdup([[exception reason] UTF8String]);
            return NULL;
        }
    }
}

void mac_stop_mic_audio_capture(void *handle) {
    if (!handle) return;
    CuviloMicCaptureSession *session = (__bridge_transfer CuviloMicCaptureSession *)handle;
    [session stop];
}
