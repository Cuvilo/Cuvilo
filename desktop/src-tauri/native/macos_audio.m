#import <Foundation/Foundation.h>
#import <AVFoundation/AVFoundation.h>
#import <CoreMedia/CoreMedia.h>
#import <CoreGraphics/CoreGraphics.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>

typedef void (*MacAudioDataCallback)(const uint8_t *pcm, size_t length, float level, void *context);
typedef void (*MacAudioErrorCallback)(const char *error_message, void *context);

bool mac_has_screen_capture_permission(void) {
    return CGPreflightScreenCaptureAccess();
}

bool mac_request_screen_capture_permission(void) {
    return CGRequestScreenCaptureAccess();
}

void mac_audio_free_string(char *s) {
    if (s) free(s);
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

        if (isFloat && numBuffers > 0) {
            float *mono = (float *)calloc((size_t)numSamples, sizeof(float));
            if (mono) {
                if (numBuffers > 1) {
                    float inv = 1.0f / (float)numBuffers;
                    for (UInt32 b = 0; b < numBuffers; b++) {
                        const float *src = (const float *)bufferList->mBuffers[b].mData;
                        if (src) {
                            for (CMItemCount i = 0; i < numSamples; i++) {
                                mono[i] += src[i] * inv;
                            }
                        }
                    }
                } else if (channels > 1) {
                    const float *src = (const float *)bufferList->mBuffers[0].mData;
                    if (src) {
                        float inv = 1.0f / (float)channels;
                        for (CMItemCount i = 0; i < numSamples; i++) {
                            float sum = 0.0f;
                            for (UInt32 c = 0; c < channels; c++) {
                                sum += src[i * channels + c];
                            }
                            mono[i] = sum * inv;
                        }
                    }
                } else {
                    const float *src = (const float *)bufferList->mBuffers[0].mData;
                    if (src) {
                        memcpy(mono, src, (size_t)numSamples * sizeof(float));
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
    if (@available(macOS 13.0, *)) {
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

        dispatch_time_t timeout = dispatch_time(DISPATCH_TIME_NOW, (int64_t)(5 * NSEC_PER_SEC));
        if (dispatch_semaphore_wait(sem, timeout) != 0 || !capturedContent) {
            if (contentError) {
                NSInteger code = contentError.code;
                NSString *desc = [contentError localizedDescription];
                if (code == -3801 || (desc && ([desc localizedCaseInsensitiveContainsString:@"declined"] ||
                                               [desc localizedCaseInsensitiveContainsString:@"denied"] ||
                                               [desc localizedCaseInsensitiveContainsString:@"permission"]))) {
                    CGRequestScreenCaptureAccess();
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
            CGRequestScreenCaptureAccess();
            if (error_out) {
                *error_out = strdup("permission_denied");
            }
            return NULL;
        }

        SCContentFilter *filter = [[SCContentFilter alloc] initWithDisplay:display
                                                     excludingApplications:@[]
                                                           exceptingWindows:@[]];

        SCStreamConfiguration *config = [[SCStreamConfiguration alloc] init];
        config.capturesAudio = YES;
        config.excludesCurrentProcessAudio = YES;
        config.channelCount = 1;
        config.sampleRate = 16000;
        config.width = 2;
        config.height = 2;
        config.minimumFrameInterval = CMTimeMake(1, 1);

        CuviloSystemCaptureSession *session = [[CuviloSystemCaptureSession alloc] init];
        session.dataCallback = data_callback;
        session.errorCallback = error_callback;
        session.context = context;
        session.running = YES;
        session.audioQueue = dispatch_queue_create("cuvilo.audio.capture", DISPATCH_QUEUE_SERIAL);

        SCStream *stream = [[SCStream alloc] initWithFilter:filter configuration:config delegate:session];
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
                    CGRequestScreenCaptureAccess();
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
    @try {
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

void mac_stop_mic_audio_capture(void *handle) {
    if (!handle) return;
    CuviloMicCaptureSession *session = (__bridge_transfer CuviloMicCaptureSession *)handle;
    [session stop];
}
