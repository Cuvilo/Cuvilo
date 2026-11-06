import Foundation
import AVFoundation
import CoreMedia
#if canImport(ScreenCaptureKit)
import ScreenCaptureKit
#endif

/// Target output audio format: 16kHz, 16-bit signed integer, mono PCM
let TARGET_SAMPLE_RATE: Double = 16000.0

func downsampleFloatTo16kMono(
    samples: UnsafePointer<Float>,
    frameCount: Int,
    channelCount: Int,
    sourceRate: Double
) -> Data {
    guard frameCount > 0 && channelCount > 0 else { return Data() }
    
    // Downmix multi-channel to mono
    var monoFloats = [Float](repeating: 0, count: frameCount)
    if channelCount == 1 {
        for i in 0..<frameCount {
            monoFloats[i] = samples[i]
        }
    } else {
        let inv = 1.0 / Float(channelCount)
        for i in 0..<frameCount {
            var sum: Float = 0
            for c in 0..<channelCount {
                sum += samples[i * channelCount + c]
            }
            monoFloats[i] = sum * inv
        }
    }
    
    // Resample if source sample rate is different from 16kHz
    let outCount: Int
    let resampledFloats: [Float]
    if abs(sourceRate - TARGET_SAMPLE_RATE) > 10.0 && sourceRate > 1000.0 {
        let step = sourceRate / TARGET_SAMPLE_RATE
        outCount = Int(Double(frameCount) * (TARGET_SAMPLE_RATE / sourceRate))
        var temp = [Float](repeating: 0, count: outCount)
        for i in 0..<outCount {
            let srcPos = Double(i) * step
            let idx0 = Int(srcPos)
            let frac = Float(srcPos - Double(idx0))
            let s0 = monoFloats[min(idx0, frameCount - 1)]
            let s1 = monoFloats[min(idx0 + 1, frameCount - 1)]
            temp[i] = s0 * (1.0 - frac) + s1 * frac
        }
        resampledFloats = temp
    } else {
        outCount = frameCount
        resampledFloats = monoFloats
    }
    
    // Convert Float32 (-1.0...1.0) to Int16
    var int16Data = Data(count: outCount * 2)
    int16Data.withUnsafeMutableBytes { (rawBuf: UnsafeMutableRawBufferPointer) in
        let ptr = rawBuf.bindMemory(to: Int16.self).baseAddress!
        for i in 0..<outCount {
            let val = max(-1.0, min(1.0, resampledFloats[i]))
            ptr[i] = Int16(val * 32767.0)
        }
    }
    return int16Data
}

#if canImport(ScreenCaptureKit)
@available(macOS 13.0, *)
final class SystemAudioRecorder: NSObject, SCStreamOutput, SCStreamDelegate {
    private var stream: SCStream?
    private let stdoutHandle = FileHandle.standardOutput
    
    func start() async throws {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        guard let display = content.displays.first else {
            fputs("ERROR: No display found for ScreenCaptureKit\n", stderr)
            exit(1)
        }
        
        let filter = SCContentFilter(display: display, excludingApplications: [], exceptingWindows: [])
        let config = SCStreamConfiguration()
        config.capturesAudio = true
        config.excludesCurrentProcessAudio = true
        config.channelCount = 1
        config.sampleRate = Int(TARGET_SAMPLE_RATE)
        
        // Minimal visual capture overhead
        config.width = 2
        config.height = 2
        config.minimumFrameInterval = CMTime(value: 1, timescale: 1)
        
        let s = SCStream(filter: filter, configuration: config, delegate: self)
        try s.addStreamOutput(self, type: .audio, sampleHandlerQueue: DispatchQueue(label: "cuvilo.sck.audio"))
        try await s.startCapture()
        self.stream = s
        fputs("READY: ScreenCaptureKit audio capture running\n", stderr)
    }
    
    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio, sampleBuffer.isValid else { return }
        guard let formatDesc = CMSampleBufferGetFormatDescription(sampleBuffer),
              let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(formatDesc)?.pointee else { return }
        
        let numSamples = CMSampleBufferGetNumSamples(sampleBuffer)
        guard numSamples > 0 else { return }
        
        var bufferListSizeNeeded = 0
        var status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
            sampleBuffer,
            bufferListSizeNeededOut: &bufferListSizeNeeded,
            bufferListOut: nil,
            bufferListSize: 0,
            blockBufferAllocator: nil,
            blockBufferMemoryAllocator: nil,
            flags: 0,
            blockBufferOut: nil
        )
        guard status == noErr, bufferListSizeNeeded > 0 else { return }

        let bufferListPointer = UnsafeMutablePointer<AudioBufferList>.allocate(capacity: bufferListSizeNeeded)
        defer { bufferListPointer.deallocate() }

        var blockBuffer: CMBlockBuffer?
        status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
            sampleBuffer,
            bufferListSizeNeededOut: nil,
            bufferListOut: bufferListPointer,
            bufferListSize: bufferListSizeNeeded,
            blockBufferAllocator: nil,
            blockBufferMemoryAllocator: nil,
            flags: 0,
            blockBufferOut: &blockBuffer
        )
        guard status == noErr else { return }

        let abl = UnsafeMutableAudioBufferListPointer(bufferListPointer)
        guard let firstBuffer = abl.first, let mData = firstBuffer.mData else { return }
        
        let channels = Int(asbd.mChannelsPerFrame)
        let isFloat = (asbd.mFormatFlags & kAudioFormatFlagIsFloat) != 0
        
        if isFloat {
            if abl.count > 1 {
                var mono = [Float](repeating: 0, count: numSamples)
                let inv = 1.0 / Float(abl.count)
                for buf in abl {
                    if let ptr = buf.mData?.assumingMemoryBound(to: Float.self) {
                        for i in 0..<numSamples {
                            mono[i] += ptr[i] * inv
                        }
                    }
                }
                mono.withUnsafeBufferPointer { p in
                    let pcm = downsampleFloatTo16kMono(
                        samples: p.baseAddress!,
                        frameCount: numSamples,
                        channelCount: 1,
                        sourceRate: asbd.mSampleRate
                    )
                    if !pcm.isEmpty {
                        try? stdoutHandle.write(contentsOf: pcm)
                    }
                }
            } else {
                let floatPtr = mData.assumingMemoryBound(to: Float.self)
                let pcm = downsampleFloatTo16kMono(
                    samples: floatPtr,
                    frameCount: numSamples,
                    channelCount: max(1, channels),
                    sourceRate: asbd.mSampleRate
                )
                if !pcm.isEmpty {
                    try? stdoutHandle.write(contentsOf: pcm)
                }
            }
        }
    }
    
    func stream(_ stream: SCStream, didStopWithError error: Error) {
        fputs("ERROR: SCStream stopped: \(error.localizedDescription)\n", stderr)
        exit(1)
    }
}
#endif

final class MicrophoneRecorder {
    private let engine = AVAudioEngine()
    private let stdoutHandle = FileHandle.standardOutput
    
    func start() throws {
        let input = engine.inputNode
        let nativeFormat = input.outputFormat(forBus: 0)
        guard nativeFormat.sampleRate > 0 else {
            throw NSError(domain: "Cuvilo", code: 1, userInfo: [NSLocalizedDescriptionKey: "Invalid mic sample rate"])
        }
        
        input.installTap(onBus: 0, bufferSize: 1024, format: nativeFormat) { [weak self] buffer, _ in
            guard let self = self else { return }
            guard let floatData = buffer.floatChannelData else { return }
            let frameCount = Int(buffer.frameLength)
            let channels = Int(buffer.format.channelCount)
            guard frameCount > 0 && channels > 0 else { return }
            
            // Interleave channels into temporary buffer
            var interleaved = [Float](repeating: 0, count: frameCount * channels)
            for c in 0..<channels {
                let channelPtr = floatData[c]
                for f in 0..<frameCount {
                    interleaved[f * channels + c] = channelPtr[f]
                }
            }
            
            interleaved.withUnsafeBufferPointer { bufPtr in
                let pcm = downsampleFloatTo16kMono(
                    samples: bufPtr.baseAddress!,
                    frameCount: frameCount,
                    channelCount: channels,
                    sourceRate: buffer.format.sampleRate
                )
                if !pcm.isEmpty {
                    try? self.stdoutHandle.write(contentsOf: pcm)
                }
            }
        }
        
        try engine.start()
        fputs("READY: Microphone audio capture running\n", stderr)
    }
}

@main
struct Main {
    static func main() async {
        let args = CommandLine.arguments
        let mode = args.firstIndex(of: "--mode").flatMap { $0 + 1 < args.count ? args[$0 + 1] : nil } ?? "system"
        
        // Handle clean termination on SIGINT / SIGTERM
        signal(SIGINT) { _ in exit(0) }
        signal(SIGTERM) { _ in exit(0) }
        
        if mode == "system" {
            #if canImport(ScreenCaptureKit)
            if #available(macOS 13.0, *) {
                let recorder = SystemAudioRecorder()
                do {
                    try await recorder.start()
                    while true {
                        try? await Task.sleep(nanoseconds: 1_000_000_000)
                    }
                } catch {
                    fputs("ERROR: ScreenCaptureKit initialization failed: \(error.localizedDescription)\n", stderr)
                    exit(1)
                }
            } else {
                fputs("ERROR: macOS 13+ is required for ScreenCaptureKit\n", stderr)
                exit(2)
            }
            #else
            fputs("ERROR: ScreenCaptureKit not available\n", stderr)
            exit(2)
            #endif
        } else {
            let mic = MicrophoneRecorder()
            do {
                try mic.start()
                while true {
                    try? await Task.sleep(nanoseconds: 1_000_000_000)
                }
            } catch {
                fputs("ERROR: Microphone initialization failed: \(error.localizedDescription)\n", stderr)
                exit(1)
            }
        }
    }
}
