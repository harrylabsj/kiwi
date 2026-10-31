import AppKit
import CoreGraphics
import Foundation

guard let app = NSWorkspace.shared.frontmostApplication else {
    fputs("frontmost application unavailable\n", stderr)
    exit(1)
}

let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
let windows = (CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]]) ?? []
let pid = app.processIdentifier

for window in windows {
    guard let ownerPID = window[kCGWindowOwnerPID as String] as? Int32,
          ownerPID == pid,
          let layer = window[kCGWindowLayer as String] as? Int,
          layer == 0,
          let number = window[kCGWindowNumber as String] as? UInt32,
          let bounds = window[kCGWindowBounds as String] as? [String: Any],
          let width = bounds["Width"] as? CGFloat,
          let height = bounds["Height"] as? CGFloat,
          width > 0,
          height > 0 else {
        continue
    }
    print(number)
    exit(0)
}

fputs("frontmost application has no visible window\n", stderr)
exit(2)
