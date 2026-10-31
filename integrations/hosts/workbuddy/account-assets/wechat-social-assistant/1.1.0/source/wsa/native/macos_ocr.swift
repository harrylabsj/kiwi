import AppKit
import Foundation
import Vision

if CommandLine.arguments.count != 2 {
    fputs("usage: macos_ocr IMAGE_PATH\n", stderr)
    exit(64)
}

let imageURL = URL(fileURLWithPath: CommandLine.arguments[1])
guard let image = NSImage(contentsOf: imageURL),
      let tiff = image.tiffRepresentation,
      let bitmap = NSBitmapImageRep(data: tiff),
      let cgImage = bitmap.cgImage else {
    fputs("failed to load image\n", stderr)
    exit(65)
}

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = true
request.recognitionLanguages = ["zh-Hans", "zh-Hant", "en-US"]

let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
do {
    try handler.perform([request])
} catch {
    fputs("vision ocr failed: \(error)\n", stderr)
    exit(66)
}

struct BoundingBox: Encodable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double
}

struct OCRObservation: Encodable {
    let text: String
    let confidence: Float
    let bbox: BoundingBox
    let source: String
}

let observations = (request.results ?? [])
    .compactMap { observation -> OCRObservation? in
        guard let candidate = observation.topCandidates(1).first else {
            return nil
        }
        let text = candidate.string.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty {
            return nil
        }
        let box = observation.boundingBox
        return OCRObservation(
            text: text,
            confidence: observation.confidence,
            bbox: BoundingBox(
                x: Double(box.origin.x),
                y: Double(box.origin.y),
                width: Double(box.size.width),
                height: Double(box.size.height)
            ),
            source: "vision"
        )
    }
    .sorted { left, right in
        let leftMidY = left.bbox.y + left.bbox.height / 2
        let rightMidY = right.bbox.y + right.bbox.height / 2
        let yDelta = abs(leftMidY - rightMidY)
        if yDelta > 0.01 {
            return leftMidY > rightMidY
        }
        return left.bbox.x < right.bbox.x
    }

let encoder = JSONEncoder()
for observation in observations {
    guard let data = try? encoder.encode(observation),
          let line = String(data: data, encoding: .utf8) else {
        continue
    }
    print(line)
}
