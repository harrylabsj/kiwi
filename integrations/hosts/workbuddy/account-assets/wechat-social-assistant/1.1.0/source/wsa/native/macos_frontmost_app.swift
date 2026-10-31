import AppKit
import Foundation

let activeApps = NSWorkspace.shared.runningApplications.filter { $0.isActive }
guard let app = activeApps.first ?? NSWorkspace.shared.frontmostApplication else {
    fputs("frontmost application unavailable\n", stderr)
    exit(1)
}

let name = app.localizedName ?? app.bundleIdentifier ?? ""
if name.isEmpty {
    fputs("frontmost application has no name\n", stderr)
    exit(2)
}

print(name)
