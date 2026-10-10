import AVFoundation
import CoreImage
import Foundation
import ImageIO
import Metal

/// Describes one export. Produced by the desktop app from `buildRenderFrames` in
/// @screensway/core, so the exported video matches the preview frame for frame.
struct ExportJob: Decodable {
    struct Rect: Decodable {
        let x: Double
        let y: Double
        let width: Double
        let height: Double
    }

    let source: String
    let output: String
    let width: Int
    let height: Int
    let fps: Int
    /// PNG of the background, shadow and title bar at the output size.
    let baseLayer: String
    /// PNG of the cursor; its tip sits at (cursorHotspotX, cursorHotspotY), as fractions of the image.
    let cursor: String
    let cursorHotspotX: Double
    let cursorHotspotY: Double
    let video: Rect
    let radius: Double
    /// False when a title bar sits above the video, so only its bottom corners are rounded.
    let roundTopCorners: Bool
    /// One entry per output frame, see `RenderFrame` in @screensway/core:
    /// [cropX, cropY, cropW, cropH, cursorX, cursorY, cursorSize, rippleX, rippleY, rippleSize, rippleAlpha]
    let frames: [[Double]]
}

struct ExportResult: Encodable {
    let outputPath: String
    let durationMs: Int
    let width: Int
    let height: Int
}

enum Exporter {
    static func run(jobURL: URL) async throws -> ExportResult {
        let job = try JSONDecoder().decode(ExportJob.self, from: Data(contentsOf: jobURL))
        guard !job.frames.isEmpty, job.fps > 0 else { throw CaptureError.exportFailed("The export has no frames.") }

        let sourceURL = URL(fileURLWithPath: job.source)
        let outputURL = URL(fileURLWithPath: job.output)
        let videoOnlyURL = outputURL.deletingPathExtension().appendingPathExtension("video.mp4")
        try? FileManager.default.removeItem(at: videoOnlyURL)
        try FileManager.default.createDirectory(at: outputURL.deletingLastPathComponent(), withIntermediateDirectories: true)

        try await renderVideo(job: job, sourceURL: sourceURL, to: videoOnlyURL)
        try await addSourceAudio(from: sourceURL, video: videoOnlyURL, to: outputURL)

        let durationMs = Int((Double(job.frames.count) / Double(job.fps) * 1_000).rounded())
        return ExportResult(outputPath: outputURL.path, durationMs: durationMs, width: job.width, height: job.height)
    }

    // MARK: Rendering

    private static func renderVideo(job: ExportJob, sourceURL: URL, to url: URL) async throws {
        let asset = AVURLAsset(url: sourceURL)
        guard let sourceTrack = try await asset.loadTracks(withMediaType: .video).first else {
            throw CaptureError.exportFailed("The recording has no video track.")
        }
        let sourceSize = try await sourceTrack.load(.naturalSize)

        let reader = try AVAssetReader(asset: asset)
        let readerOutput = AVAssetReaderTrackOutput(track: sourceTrack, outputSettings: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
        ])
        readerOutput.alwaysCopiesSampleData = false
        reader.add(readerOutput)
        guard reader.startReading() else {
            throw reader.error ?? CaptureError.exportFailed("The recording could not be read.")
        }

        let writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
        let bitrate = min(100_000_000, max(8_000_000, Double(job.width * job.height * job.fps) * 0.12))
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: job.width,
            AVVideoHeightKey: job.height,
            AVVideoColorPropertiesKey: [
                AVVideoColorPrimariesKey: AVVideoColorPrimaries_ITU_R_709_2,
                AVVideoTransferFunctionKey: AVVideoTransferFunction_ITU_R_709_2,
                AVVideoYCbCrMatrixKey: AVVideoYCbCrMatrix_ITU_R_709_2,
            ],
            AVVideoCompressionPropertiesKey: [
                AVVideoAverageBitRateKey: bitrate,
                AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
                AVVideoExpectedSourceFrameRateKey: job.fps,
                AVVideoMaxKeyFrameIntervalDurationKey: 2,
            ],
        ])
        input.expectsMediaDataInRealTime = false
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
            kCVPixelBufferWidthKey as String: job.width,
            kCVPixelBufferHeightKey as String: job.height,
            kCVPixelBufferMetalCompatibilityKey as String: true,
            kCVPixelBufferIOSurfacePropertiesKey as String: [:],
        ])
        guard writer.canAdd(input) else { throw CaptureError.exportFailed("The video encoder rejected the export settings.") }
        writer.add(input)
        guard writer.startWriting() else {
            throw writer.error ?? CaptureError.exportFailed("The export file could not be created.")
        }
        writer.startSession(atSourceTime: .zero)

        let colorSpace = CGColorSpace(name: CGColorSpace.sRGB)!
        let context: CIContext = MTLCreateSystemDefaultDevice().map {
            CIContext(mtlDevice: $0, options: [.cacheIntermediates: false])
        } ?? CIContext(options: [.cacheIntermediates: false])

        let outputHeight = Double(job.height)
        let outputBounds = CGRect(x: 0, y: 0, width: job.width, height: job.height)
        let base = try loadImage(job.baseLayer).cropped(to: outputBounds)
        let cursor = try loadImage(job.cursor)
        let ripple = makeRippleImage(diameter: 256)
        let videoRect = CGRect(
            x: job.video.x,
            y: outputHeight - job.video.y - job.video.height,
            width: job.video.width,
            height: job.video.height
        )
        let mask = makeMask(size: outputBounds.size, rect: videoRect, radius: job.radius, roundTop: job.roundTopCorners)

        var current: CMSampleBuffer?
        var pending = readerOutput.copyNextSampleBuffer()
        var lastReported = -1

        for (index, frame) in job.frames.enumerated() where frame.count >= 11 {
            try autoreleasepool {
                // Recordings have a variable frame rate: show the newest source frame at or before this time.
                let time = CMTime(value: CMTimeValue(index), timescale: CMTimeScale(job.fps))
                while let next = pending, next.presentationTimeStamp <= time + CMTime(value: 1, timescale: 1_000) {
                    current = next
                    pending = readerOutput.copyNextSampleBuffer()
                }
                guard let sample = current ?? pending, let imageBuffer = sample.imageBuffer else {
                    throw CaptureError.exportFailed("The recording ended before the export did.")
                }

                // Crop in top-left source coordinates, converted to Core Image's bottom-left origin.
                let crop = CGRect(x: frame[0], y: sourceSize.height - frame[1] - frame[3], width: frame[2], height: frame[3])
                let verticalScale = videoRect.height / crop.height
                let horizontalScale = videoRect.width / crop.width
                // Lanczos samples beyond its input, so scale a slightly larger, edge-extended crop
                // and trim it afterwards; otherwise the video edges pick up a dark fringe.
                var video = CIImage(cvImageBuffer: imageBuffer)
                    .clampedToExtent()
                    .cropped(to: crop.insetBy(dx: -4, dy: -4))
                    .transformed(by: CGAffineTransform(translationX: -crop.minX, y: -crop.minY))
                    .applyingFilter("CILanczosScaleTransform", parameters: [
                        kCIInputScaleKey: verticalScale,
                        kCIInputAspectRatioKey: horizontalScale / verticalScale,
                    ])
                    .transformed(by: CGAffineTransform(translationX: videoRect.minX, y: videoRect.minY))
                    .cropped(to: videoRect)

                if frame[10] > 0, frame[9] > 0 {
                    let size = frame[9]
                    let rippleScale = size / ripple.extent.width
                    let placed = ripple
                        .transformed(by: CGAffineTransform(scaleX: rippleScale, y: rippleScale))
                        .transformed(by: CGAffineTransform(translationX: frame[7] - size / 2, y: outputHeight - frame[8] - size / 2))
                        .applyingFilter("CIColorMatrix", parameters: ["inputAVector": CIVector(x: 0, y: 0, z: 0, w: frame[10])])
                    video = placed.composited(over: video)
                }
                if frame[6] > 0 {
                    let cursorScale = frame[6] / cursor.extent.width
                    let width = cursor.extent.width * cursorScale
                    let height = cursor.extent.height * cursorScale
                    let left = frame[4] - job.cursorHotspotX * width
                    let top = frame[5] - job.cursorHotspotY * height
                    let placed = cursor
                        .transformed(by: CGAffineTransform(scaleX: cursorScale, y: cursorScale))
                        .transformed(by: CGAffineTransform(translationX: left, y: outputHeight - top - height))
                    video = placed.composited(over: video)
                }

                let composed = video.cropped(to: videoRect).applyingFilter("CIBlendWithMask", parameters: [
                    kCIInputBackgroundImageKey: base,
                    kCIInputMaskImageKey: mask,
                ])

                while !input.isReadyForMoreMediaData { Thread.sleep(forTimeInterval: 0.001) }
                guard let pool = adaptor.pixelBufferPool else {
                    throw writer.error ?? CaptureError.exportFailed("The encoder is not ready.")
                }
                var pixelBuffer: CVPixelBuffer?
                CVPixelBufferPoolCreatePixelBuffer(nil, pool, &pixelBuffer)
                guard let pixelBuffer else { throw CaptureError.exportFailed("Out of video memory.") }
                context.render(composed, to: pixelBuffer, bounds: outputBounds, colorSpace: colorSpace)
                guard adaptor.append(pixelBuffer, withPresentationTime: time) else {
                    throw writer.error ?? CaptureError.exportFailed("A frame could not be encoded.")
                }

                let percent = (index + 1) * 100 / job.frames.count
                if percent != lastReported {
                    lastReported = percent
                    FileHandle.standardError.write(Data("SCREENSWAY_PROGRESS \(percent)\n".utf8))
                }
            }
        }

        reader.cancelReading()
        input.markAsFinished()
        await writer.finishWriting()
        if writer.status != .completed {
            throw writer.error ?? CaptureError.exportFailed("The exported video could not be finalized.")
        }
    }

    /// Copies the recording's audio (unchanged) next to the rendered video.
    private static func addSourceAudio(from sourceURL: URL, video videoURL: URL, to outputURL: URL) async throws {
        try? FileManager.default.removeItem(at: outputURL)
        let source = AVURLAsset(url: sourceURL)
        guard let audioTrack = try await source.loadTracks(withMediaType: .audio).first else {
            try FileManager.default.moveItem(at: videoURL, to: outputURL)
            return
        }
        let rendered = AVURLAsset(url: videoURL)
        guard let videoTrack = try await rendered.loadTracks(withMediaType: .video).first else {
            throw CaptureError.exportFailed("The rendered video has no track.")
        }
        let duration = try await rendered.load(.duration)
        let audioDuration = try await audioTrack.load(.timeRange).duration

        let composition = AVMutableComposition()
        guard let compositionVideo = composition.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid),
              let compositionAudio = composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid) else {
            throw CaptureError.exportFailed("Could not combine video and audio.")
        }
        try compositionVideo.insertTimeRange(CMTimeRange(start: .zero, duration: duration), of: videoTrack, at: .zero)
        try compositionAudio.insertTimeRange(
            CMTimeRange(start: .zero, duration: CMTimeMinimum(duration, audioDuration)), of: audioTrack, at: .zero
        )
        guard let exporter = AVAssetExportSession(asset: composition, presetName: AVAssetExportPresetPassthrough) else {
            throw CaptureError.exportFailed("Could not initialize the exporter.")
        }
        try await exporter.export(to: outputURL, as: .mp4)
        try? FileManager.default.removeItem(at: videoURL)
    }

    // MARK: Images

    private static func loadImage(_ path: String) throws -> CIImage {
        guard let image = CIImage(contentsOf: URL(fileURLWithPath: path)) else {
            throw CaptureError.exportFailed("Could not read \(URL(fileURLWithPath: path).lastPathComponent).")
        }
        return image
    }

    /// White where the video shows, black elsewhere; rounds the corners that are not under a title bar.
    private static func makeMask(size: CGSize, rect: CGRect, radius: Double, roundTop: Bool) -> CIImage {
        let width = Int(size.width), height = Int(size.height)
        let context = CGContext(
            data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue
        )!
        context.setFillColor(gray: 0, alpha: 1)
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        context.setFillColor(gray: 1, alpha: 1)
        let r = min(radius, rect.width / 2, rect.height / 2)
        let topRadius = roundTop ? r : 0
        // Core Graphics has a bottom-left origin: the visual top edge is rect.maxY.
        let path = CGMutablePath()
        path.move(to: CGPoint(x: rect.minX + r, y: rect.minY))
        path.addLine(to: CGPoint(x: rect.maxX - r, y: rect.minY))
        path.addArc(tangent1End: CGPoint(x: rect.maxX, y: rect.minY), tangent2End: CGPoint(x: rect.maxX, y: rect.minY + r), radius: r)
        path.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY - topRadius))
        path.addArc(tangent1End: CGPoint(x: rect.maxX, y: rect.maxY), tangent2End: CGPoint(x: rect.maxX - topRadius, y: rect.maxY), radius: topRadius)
        path.addLine(to: CGPoint(x: rect.minX + topRadius, y: rect.maxY))
        path.addArc(tangent1End: CGPoint(x: rect.minX, y: rect.maxY), tangent2End: CGPoint(x: rect.minX, y: rect.maxY - topRadius), radius: topRadius)
        path.addLine(to: CGPoint(x: rect.minX, y: rect.minY + r))
        path.addArc(tangent1End: CGPoint(x: rect.minX, y: rect.minY), tangent2End: CGPoint(x: rect.minX + r, y: rect.minY), radius: r)
        path.closeSubpath()
        context.addPath(path)
        context.fillPath()
        return CIImage(cgImage: context.makeImage()!)
    }

    /// The click ripple from the preview: a tinted disc with a white ring.
    private static func makeRippleImage(diameter: Int) -> CIImage {
        let context = CGContext(
            data: nil, width: diameter, height: diameter, bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        )!
        let line = Double(diameter) * 0.045
        let circle = CGRect(x: line / 2, y: line / 2, width: Double(diameter) - line, height: Double(diameter) - line)
        context.setFillColor(red: 129 / 255, green: 140 / 255, blue: 248 / 255, alpha: 0.25)
        context.fillEllipse(in: circle)
        context.setStrokeColor(red: 1, green: 1, blue: 1, alpha: 0.85)
        context.setLineWidth(line)
        context.strokeEllipse(in: circle)
        return CIImage(cgImage: context.makeImage()!)
    }
}
