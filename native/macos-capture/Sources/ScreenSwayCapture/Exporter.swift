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
    let sourceWidth: Double?
    let sourceHeight: Double?
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
    /// Where the export starts in the recording, when the start was trimmed.
    let startMs: Double?
    let sourceTimesMs: [Double]?
    /// Silence before the recording's sound, under an intro card.
    let leadInMs: Double?
    let sourceRanges: [SourceRange]?
    let redactions: [Redaction]?
    /// Captions drawn over the finished frame, timed on the exported video's timeline.
    let captions: [Caption]?
    /// The webcam, drawn over the finished frame.
    let camera: Camera?

    struct Camera: Decodable {
        let path: String
        /// How much later than the screen the camera file starts.
        let offsetMs: Double?
        /// The box in top-left output pixels; the picture fills it.
        let x: Double
        let y: Double
        let width: Double
        let height: Double
        let radius: Double
        let mirror: Bool?
    }

    struct Caption: Decodable {
        let startMs: Double
        let endMs: Double
        /// PNG of the caption, already sized for the output.
        let image: String
        /// Top-left corner in output pixels.
        let x: Double
        let y: Double
    }

    struct Redaction: Decodable {
        let x: Double
        let y: Double
        let width: Double
        let height: Double
        let mode: String
    }

    struct SourceRange: Decodable {
        let startMs: Double
        let endMs: Double
        var timeRange: CMTimeRange {
            CMTimeRange(
                start: CMTime(value: CMTimeValue(startMs.rounded()), timescale: 1_000),
                end: CMTime(value: CMTimeValue(endMs.rounded()), timescale: 1_000)
            )
        }
    }

    var start: CMTime {
        CMTime(value: CMTimeValue(max(0, startMs ?? 0).rounded()), timescale: 1_000)
    }
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
        try await addSourceAudio(from: sourceURL, ranges: job.sourceRanges, startingAt: job.start, leadIn: CMTime(value: CMTimeValue((job.leadInMs ?? 0).rounded()), timescale: 1_000), video: videoOnlyURL, to: outputURL)

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
        // Skip most of a trimmed start, keeping a little earlier: on a still screen the
        // frame that is showing at the start may have arrived a while before it.
        let preroll = CMTime(value: 3, timescale: 1)
        if job.start > preroll {
            reader.timeRange = CMTimeRange(start: job.start - preroll, duration: .positiveInfinity)
        }
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

        var camera: CameraTrack?
        if let placement = job.camera {
            camera = try await CameraTrack(placement: placement, outputHeight: outputHeight)
        }

        var current: CMSampleBuffer?
        var pending = readerOutput.copyNextSampleBuffer()
        var lastReported = -1
        let captions = (job.captions ?? []).sorted { $0.startMs < $1.startMs }
        var loadedCaptions: [Int: CIImage] = [:]

        for (index, frame) in job.frames.enumerated() where frame.count >= 11 {
            try autoreleasepool {
                // Recordings have a variable frame rate: show the newest source frame at or before this time.
                let time = CMTime(value: CMTimeValue(index), timescale: CMTimeScale(job.fps))
                let sourceTime = job.sourceTimesMs.flatMap { index < $0.count ? CMTime(value: CMTimeValue($0[index].rounded()), timescale: 1_000) : nil } ?? (job.start + time)
                while let next = pending, next.presentationTimeStamp <= sourceTime + CMTime(value: 1, timescale: 1_000) {
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

                // Redactions are stored in normalized source coordinates. Project them through the
                // current animated crop so they stay attached while zooming; the cursor stays above them.
                let sourceWidth = job.sourceWidth ?? sourceSize.width
                let sourceHeight = job.sourceHeight ?? sourceSize.height
                for redaction in job.redactions ?? [] {
                    let sourceRedaction = CGRect(
                        x: redaction.x * sourceWidth,
                        y: redaction.y * sourceHeight,
                        width: redaction.width * sourceWidth,
                        height: redaction.height * sourceHeight
                    )
                    let top = job.video.y + (sourceRedaction.minY - frame[1]) / frame[3] * job.video.height
                    let projected = CGRect(
                        x: job.video.x + (sourceRedaction.minX - frame[0]) / frame[2] * job.video.width,
                        y: outputHeight - top - sourceRedaction.height / frame[3] * job.video.height,
                        width: sourceRedaction.width / frame[2] * job.video.width,
                        height: sourceRedaction.height / frame[3] * job.video.height
                    ).intersection(videoRect)
                    guard !projected.isNull, projected.width > 0, projected.height > 0 else { continue }
                    if redaction.mode == "solid" {
                        let cover = CIImage(color: CIColor(red: 0.067, green: 0.067, blue: 0.067, alpha: 1)).cropped(to: projected)
                        video = cover.composited(over: video)
                    } else {
                        let blurred = video
                            .clampedToExtent()
                            .applyingFilter("CIGaussianBlur", parameters: [kCIInputRadiusKey: 18])
                            .cropped(to: projected)
                        video = blurred.composited(over: video)
                    }
                }

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

                var composed = video.cropped(to: videoRect).applyingFilter("CIBlendWithMask", parameters: [
                    kCIInputBackgroundImageKey: base,
                    kCIInputMaskImageKey: mask,
                ])

                if let image = camera?.image(at: sourceTime) {
                    composed = image.applyingFilter("CIBlendWithMask", parameters: [
                        kCIInputBackgroundImageKey: composed,
                        kCIInputMaskImageKey: camera!.mask,
                    ])
                }

                let timeMs = Double(index) * 1_000 / Double(job.fps)
                for (captionIndex, caption) in captions.enumerated() where caption.startMs <= timeMs && timeMs < caption.endMs {
                    if loadedCaptions[captionIndex] == nil { loadedCaptions[captionIndex] = try loadImage(caption.image) }
                    let image = loadedCaptions[captionIndex]!
                    let placed = image.transformed(by: CGAffineTransform(
                        translationX: caption.x, y: outputHeight - caption.y - image.extent.height
                    ))
                    composed = placed.composited(over: composed)
                }
                // Only the overlays still to come stay in memory.
                loadedCaptions = loadedCaptions.filter { captions[$0.key].endMs > timeMs }

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
        camera?.cancel()
        input.markAsFinished()
        await writer.finishWriting()
        if writer.status != .completed {
            throw writer.error ?? CaptureError.exportFailed("The exported video could not be finalized.")
        }
    }

    /// Copies the recording's audio (unchanged, from the trimmed start) next to the rendered video.
    private static func addSourceAudio(from sourceURL: URL, ranges: [ExportJob.SourceRange]?, startingAt start: CMTime, leadIn: CMTime, video videoURL: URL, to outputURL: URL) async throws {
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
        let sourceAudioEnd = try await audioTrack.load(.timeRange).end
        let audioRanges = ranges?.map(\.timeRange) ?? [CMTimeRange(start: start, duration: duration)]
        guard audioRanges.contains(where: { $0.start < sourceAudioEnd && $0.duration > .zero }) else {
            try FileManager.default.moveItem(at: videoURL, to: outputURL)
            return
        }

        let composition = AVMutableComposition()
        guard let compositionVideo = composition.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid),
              let compositionAudio = composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid) else {
            throw CaptureError.exportFailed("Could not combine video and audio.")
        }
        try compositionVideo.insertTimeRange(CMTimeRange(start: .zero, duration: duration), of: videoTrack, at: .zero)
        var destination = CMTime.zero
        for range in audioRanges {
            let available = CMTimeMaximum(.zero, sourceAudioEnd - range.start)
            let clipped = CMTimeRange(start: range.start, duration: CMTimeMinimum(range.duration, available))
            if clipped.duration > .zero {
                try compositionAudio.insertTimeRange(clipped, of: audioTrack, at: destination)
                destination = destination + clipped.duration
            }
        }
        // Silence under an intro card: shifts the sound (an empty track cannot start later on its own).
        if leadIn > .zero, destination > .zero {
            compositionAudio.insertEmptyTimeRange(CMTimeRange(start: .zero, duration: leadIn))
        }
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

/// Reads the webcam file alongside the screen and places each frame in its rounded box.
private final class CameraTrack {
    let mask: CIImage
    private let reader: AVAssetReader
    private let output: AVAssetReaderTrackOutput
    private let placement: ExportJob.Camera
    private let box: CGRect
    private let offset: CMTime
    private var current: CMSampleBuffer?
    private var pending: CMSampleBuffer?

    init(placement: ExportJob.Camera, outputHeight: Double) async throws {
        let asset = AVURLAsset(url: URL(fileURLWithPath: placement.path))
        guard let track = try await asset.loadTracks(withMediaType: .video).first else {
            throw CaptureError.exportFailed("The camera recording has no video.")
        }
        reader = try AVAssetReader(asset: asset)
        output = AVAssetReaderTrackOutput(track: track, outputSettings: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
        ])
        output.alwaysCopiesSampleData = false
        reader.add(output)
        guard reader.startReading() else {
            throw reader.error ?? CaptureError.exportFailed("The camera recording could not be read.")
        }
        self.placement = placement
        box = CGRect(x: placement.x, y: outputHeight - placement.y - placement.height, width: placement.width, height: placement.height)
        offset = CMTime(value: CMTimeValue((placement.offsetMs ?? 0).rounded()), timescale: 1_000)
        let radius = min(placement.radius, placement.width / 2, placement.height / 2)
        mask = CIFilter(name: "CIRoundedRectangleGenerator", parameters: [
            "inputExtent": CIVector(cgRect: box),
            "inputRadius": radius,
            "inputColor": CIColor.white,
        ])!.outputImage!.cropped(to: box)
        pending = output.copyNextSampleBuffer()
    }

    /// The camera frame showing at `screenTime`, filling the box (the middle of the picture is kept).
    func image(at screenTime: CMTime) -> CIImage? {
        let time = screenTime - offset
        while let next = pending, next.presentationTimeStamp <= time + CMTime(value: 1, timescale: 1_000) {
            current = next
            pending = output.copyNextSampleBuffer()
        }
        guard let buffer = (current ?? pending)?.imageBuffer else { return nil }
        var image = CIImage(cvImageBuffer: buffer)
        let extent = image.extent
        let scale = max(box.width / extent.width, box.height / extent.height)
        if placement.mirror ?? false {
            image = image.transformed(by: CGAffineTransform(scaleX: -1, y: 1).translatedBy(x: -extent.width, y: 0))
        }
        return image
            .transformed(by: CGAffineTransform(scaleX: scale, y: scale))
            .transformed(by: CGAffineTransform(
                translationX: box.midX - extent.width * scale / 2,
                y: box.midY - extent.height * scale / 2
            ))
            .cropped(to: box)
    }

    func cancel() { reader.cancelReading() }
}
