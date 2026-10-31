"""Perception connector contracts.

The relationship engine should not know whether evidence came from a visible
window capture, Accessibility, an official connector, or a user import.  This
module is the small seam for those providers; v1 ships the existing macOS
screen/window capture and an Accessibility permission probe.
"""

from __future__ import annotations

from dataclasses import dataclass
import os
from pathlib import Path
import platform
import shutil
import subprocess
from typing import Protocol


PROJECT_ROOT = Path(__file__).resolve().parents[1]
PACKAGE_ROOT = Path(__file__).resolve().parent
SOURCE_ROOT = PROJECT_ROOT / "tools"
PACKAGED_SOURCE_ROOT = PACKAGE_ROOT / "native"
ACCESSIBILITY_SOURCE = (
    SOURCE_ROOT / "macos_accessibility_probe.swift"
    if (SOURCE_ROOT / "macos_accessibility_probe.swift").exists()
    else PACKAGED_SOURCE_ROOT / "macos_accessibility_probe.swift"
)
if (SOURCE_ROOT / "macos_ocr.swift").exists() and os.access(PROJECT_ROOT, os.W_OK):
    BINARY_ROOT = PROJECT_ROOT / "bin"
else:
    BINARY_ROOT = Path.home() / "Library" / "Caches" / "wechat-social-assistant" / "bin"
ACCESSIBILITY_BINARY = BINARY_ROOT / "macos_accessibility_probe"


@dataclass(frozen=True)
class CaptureRequest:
    output_path: Path
    mode: str = "window"
    crop: str | None = None
    crop_preset: str = "none"


@dataclass(frozen=True)
class ConnectorStatus:
    name: str
    available: bool
    detail: str
    can_capture: bool = False
    can_read_text: bool = False


class CaptureConnector(Protocol):
    name: str

    def capture(self, request: CaptureRequest) -> Path:
        ...

    def status(self) -> ConnectorStatus:
        ...


class MacOSScreenCaptureConnector:
    name = "macos-screen-capture"

    def capture(self, request: CaptureRequest) -> Path:
        from .ocr import _capture_screenshot_legacy

        return _capture_screenshot_legacy(
            request.output_path,
            mode="screen",
            crop=request.crop,
            crop_preset=request.crop_preset,
        )

    def status(self) -> ConnectorStatus:
        available = platform.system() == "Darwin" and shutil.which("screencapture") is not None
        detail = "screencapture available" if available else "requires macOS screencapture"
        return ConnectorStatus(self.name, available, detail, can_capture=available)


class MacOSWindowCaptureConnector:
    name = "macos-window-capture"

    def capture(self, request: CaptureRequest) -> Path:
        from .ocr import _capture_screenshot_legacy

        return _capture_screenshot_legacy(
            request.output_path,
            mode="window",
            crop=request.crop,
            crop_preset=request.crop_preset,
        )

    def status(self) -> ConnectorStatus:
        available = platform.system() == "Darwin" and shutil.which("screencapture") is not None
        detail = "window capture uses the frontmost window id" if available else "requires macOS screencapture"
        return ConnectorStatus(self.name, available, detail, can_capture=available)


class MacOSAccessibilityConnector:
    """Probe Accessibility trust before a future AX text-tree reader is used."""

    name = "macos-accessibility"

    def capture(self, request: CaptureRequest) -> Path:
        raise RuntimeError(
            "Accessibility connector currently probes permission only; use window capture/OCR for evidence"
        )

    def status(self) -> ConnectorStatus:
        if platform.system() != "Darwin":
            return ConnectorStatus(self.name, False, "requires macOS Accessibility", can_read_text=False)
        try:
            binary = ensure_accessibility_probe()
            result = subprocess.run([str(binary)], text=True, capture_output=True, timeout=5)
        except (OSError, RuntimeError, subprocess.SubprocessError) as exc:
            return ConnectorStatus(self.name, False, f"Accessibility probe unavailable: {exc}")
        if result.returncode != 0:
            return ConnectorStatus(
                self.name,
                False,
                result.stderr.strip() or "Accessibility probe failed",
            )
        trusted = result.stdout.strip().lower() == "trusted"
        detail = "Accessibility permission granted" if trusted else "Accessibility permission not granted"
        return ConnectorStatus(self.name, trusted, detail, can_read_text=trusted)


def capture_connector(mode: str) -> CaptureConnector:
    if mode == "screen":
        return MacOSScreenCaptureConnector()
    if mode == "window":
        return MacOSWindowCaptureConnector()
    raise ValueError("mode must be 'screen' or 'window'")


def connector_statuses() -> tuple[ConnectorStatus, ...]:
    return (
        MacOSWindowCaptureConnector().status(),
        MacOSScreenCaptureConnector().status(),
        MacOSAccessibilityConnector().status(),
    )


def ensure_accessibility_probe() -> Path:
    if platform.system() != "Darwin":
        raise RuntimeError("Accessibility probe currently supports macOS only")
    if not ACCESSIBILITY_SOURCE.exists():
        raise RuntimeError(f"Accessibility probe source missing: {ACCESSIBILITY_SOURCE}")
    if _needs_build(ACCESSIBILITY_SOURCE, ACCESSIBILITY_BINARY):
        ACCESSIBILITY_BINARY.parent.mkdir(parents=True, exist_ok=True)
        result = subprocess.run(
            ["swiftc", str(ACCESSIBILITY_SOURCE), "-o", str(ACCESSIBILITY_BINARY)],
            text=True,
            capture_output=True,
            timeout=30,
        )
        if result.returncode != 0:
            raise RuntimeError(result.stderr.strip() or "swiftc failed")
    return ACCESSIBILITY_BINARY


def _needs_build(source: Path, binary: Path) -> bool:
    try:
        return not binary.exists() or binary.stat().st_mtime < source.stat().st_mtime
    except OSError:
        return True
