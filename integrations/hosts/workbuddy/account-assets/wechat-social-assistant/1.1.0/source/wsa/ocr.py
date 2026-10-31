from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
import json
import os
from pathlib import Path
import platform
import subprocess

from .observations import OCRObservation, observation_from_mapping


PROJECT_ROOT = Path(__file__).resolve().parents[1]
PACKAGE_ROOT = Path(__file__).resolve().parent
SOURCE_ROOT = PROJECT_ROOT / "tools"
PACKAGED_SOURCE_ROOT = PACKAGE_ROOT / "native"
OCR_SOURCE = SOURCE_ROOT / "macos_ocr.swift" if (SOURCE_ROOT / "macos_ocr.swift").exists() else PACKAGED_SOURCE_ROOT / "macos_ocr.swift"
FRONTMOST_SOURCE = (
    SOURCE_ROOT / "macos_frontmost_app.swift"
    if (SOURCE_ROOT / "macos_frontmost_app.swift").exists()
    else PACKAGED_SOURCE_ROOT / "macos_frontmost_app.swift"
)
FRONTMOST_WINDOW_SOURCE = (
    SOURCE_ROOT / "macos_frontmost_window.swift"
    if (SOURCE_ROOT / "macos_frontmost_window.swift").exists()
    else PACKAGED_SOURCE_ROOT / "macos_frontmost_window.swift"
)
PROJECT_BINARY_ROOT = PROJECT_ROOT / "bin"
# A source checkout may keep compiled helpers beside ``tools``.  Installed
# wheels must never try to write into site-packages, so they use a per-user
# cache instead.
if (SOURCE_ROOT / "macos_ocr.swift").exists() and os.access(PROJECT_ROOT, os.W_OK):
    BINARY_ROOT = PROJECT_BINARY_ROOT
else:
    BINARY_ROOT = Path.home() / "Library" / "Caches" / "wechat-social-assistant" / "bin"
OCR_BINARY = BINARY_ROOT / "macos_ocr"
FRONTMOST_BINARY = BINARY_ROOT / "macos_frontmost_app"
FRONTMOST_WINDOW_BINARY = BINARY_ROOT / "macos_frontmost_window"


class CaptureError(RuntimeError):
    pass


class OCRText(str):
    """String-compatible OCR result carrying structured observations."""

    def __new__(cls, text: str, observations: tuple[OCRObservation, ...] = ()):
        instance = super().__new__(cls, text)
        instance.observations = observations
        return instance


@dataclass(frozen=True)
class FrontmostAppStatus:
    name: str | None
    method: str
    detail: str


@dataclass(frozen=True)
class CropRegion:
    x: int
    y: int
    width: int
    height: int


def capture_screenshot(
    output_path: Path | str,
    *,
    mode: str = "screen",
    crop: str | None = None,
    crop_preset: str = "none",
) -> Path:
    """Capture through the selected perception connector."""

    from .connectors import CaptureRequest, capture_connector

    return capture_connector(mode).capture(
        CaptureRequest(
            output_path=Path(output_path),
            mode=mode,
            crop=crop,
            crop_preset=crop_preset,
        )
    )


def _capture_screenshot_legacy(
    output_path: Path | str,
    *,
    mode: str = "screen",
    crop: str | None = None,
    crop_preset: str = "none",
) -> Path:
    path = Path(output_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    args = ["screencapture", "-x", "-o"]
    if mode == "window":
        # ``-W`` opens an interactive picker and cannot be used safely by a
        # background watcher. Resolve the already-frontmost WeChat window to
        # an ID and capture only that window.
        args.extend(["-l", str(frontmost_window_id())])
    elif mode != "screen":
        raise ValueError("mode must be 'screen' or 'window'")
    args.append(str(path))
    result = subprocess.run(args, text=True, capture_output=True)
    if result.returncode != 0:
        raise CaptureError(result.stderr.strip() or "screencapture failed")
    region = resolve_crop_region(path, crop=crop, crop_preset=crop_preset)
    if region:
        crop_image(path, region)
    return path


def ocr_image(image_path: Path | str, *, build: bool = True) -> str:
    observations = ocr_image_observations(image_path, build=build)
    return OCRText("\n".join(observation.text for observation in observations), observations)


def ocr_image_observations(image_path: Path | str, *, build: bool = True) -> tuple[OCRObservation, ...]:
    if platform.system() != "Darwin":
        raise CaptureError("OCR helper currently supports macOS only.")
    binary = ensure_ocr_helper() if build else OCR_BINARY
    if not binary.exists():
        raise CaptureError(f"OCR helper is not built. Run: swiftc {OCR_SOURCE} -o {OCR_BINARY}")
    result = subprocess.run(
        [str(binary), str(image_path)],
        text=True,
        capture_output=True,
    )
    if result.returncode != 0:
        raise CaptureError(result.stderr.strip() or "OCR failed")
    return _parse_ocr_output(result.stdout)


def _parse_ocr_output(output: str) -> tuple[OCRObservation, ...]:
    observations: list[OCRObservation] = []
    lines = [line.strip() for line in output.splitlines() if line.strip()]
    for index, line in enumerate(lines):
        try:
            payload = json.loads(line)
        except json.JSONDecodeError:
            # Keep compatibility with an older helper binary that printed
            # plain text lines while the source is being upgraded.
            observations.append(OCRObservation(text=line, source="vision-legacy", sequence=index))
            continue
        if isinstance(payload, dict):
            observation = observation_from_mapping(payload, source="vision")
            observations.append(OCRObservation(**{**observation.__dict__, "sequence": index}))
            continue
        if isinstance(payload, list):
            for item in payload:
                if isinstance(item, dict):
                    observations.append(observation_from_mapping(item, source="vision"))
    return tuple(
        OCRObservation(**{**observation.__dict__, "sequence": index})
        for index, observation in enumerate(observations)
        if observation.text.strip()
    )


def ensure_ocr_helper() -> Path:
    if _needs_build(OCR_SOURCE, OCR_BINARY):
        OCR_BINARY.parent.mkdir(parents=True, exist_ok=True)
        result = subprocess.run(
            ["swiftc", str(OCR_SOURCE), "-o", str(OCR_BINARY)],
            text=True,
            capture_output=True,
        )
        if result.returncode != 0:
            raise CaptureError(result.stderr.strip() or "swiftc failed")
    return OCR_BINARY


def ensure_frontmost_helper() -> Path:
    if _needs_build(FRONTMOST_SOURCE, FRONTMOST_BINARY):
        FRONTMOST_BINARY.parent.mkdir(parents=True, exist_ok=True)
        result = subprocess.run(
            ["swiftc", str(FRONTMOST_SOURCE), "-o", str(FRONTMOST_BINARY)],
            text=True,
            capture_output=True,
        )
        if result.returncode != 0:
            raise CaptureError(result.stderr.strip() or "swiftc failed")
    return FRONTMOST_BINARY


def ensure_frontmost_window_helper() -> Path:
    if _needs_build(FRONTMOST_WINDOW_SOURCE, FRONTMOST_WINDOW_BINARY):
        FRONTMOST_WINDOW_BINARY.parent.mkdir(parents=True, exist_ok=True)
        result = subprocess.run(
            ["swiftc", str(FRONTMOST_WINDOW_SOURCE), "-o", str(FRONTMOST_WINDOW_BINARY)],
            text=True,
            capture_output=True,
        )
        if result.returncode != 0:
            raise CaptureError(result.stderr.strip() or "swiftc failed")
    return FRONTMOST_WINDOW_BINARY


def frontmost_window_id() -> int:
    if platform.system() != "Darwin":
        raise CaptureError("window capture currently supports macOS only.")
    try:
        binary = ensure_frontmost_window_helper()
    except Exception as exc:
        raise CaptureError(f"frontmost window helper unavailable: {exc}") from exc
    result = subprocess.run([str(binary)], text=True, capture_output=True)
    if result.returncode != 0:
        raise CaptureError(result.stderr.strip() or "frontmost window lookup failed")
    try:
        window_id = int(result.stdout.strip())
    except ValueError as exc:
        raise CaptureError("frontmost window helper returned an invalid window id") from exc
    if window_id <= 0:
        raise CaptureError("frontmost window helper returned an invalid window id")
    return window_id


def next_capture_path(root: Path | str) -> Path:
    timestamp = datetime.now().astimezone().strftime("%Y%m%d-%H%M%S-%f")
    return Path(root) / "captures" / f"wechat-{timestamp}.png"


def parse_crop_spec(spec: str) -> CropRegion:
    parts = [part.strip() for part in spec.split(",")]
    if len(parts) != 4:
        raise ValueError("crop must be x,y,width,height")
    try:
        x, y, width, height = (int(part) for part in parts)
    except ValueError as exc:
        raise ValueError("crop values must be integers") from exc
    region = CropRegion(x=x, y=y, width=width, height=height)
    _validate_positive_region(region)
    return region


def image_size(image_path: Path | str) -> tuple[int, int]:
    result = subprocess.run(
        ["sips", "-g", "pixelWidth", "-g", "pixelHeight", str(image_path)],
        text=True,
        capture_output=True,
    )
    if result.returncode != 0:
        raise CaptureError(result.stderr.strip() or "failed to inspect image size")
    width = height = None
    for line in result.stdout.splitlines():
        stripped = line.strip()
        if stripped.startswith("pixelWidth:"):
            width = int(stripped.split(":", 1)[1].strip())
        elif stripped.startswith("pixelHeight:"):
            height = int(stripped.split(":", 1)[1].strip())
    if width is None or height is None:
        raise CaptureError("failed to parse image size")
    return width, height


def resolve_crop_region(
    image_path: Path | str,
    *,
    crop: str | None = None,
    crop_preset: str = "none",
) -> CropRegion | None:
    if crop:
        region = parse_crop_spec(crop)
    elif crop_preset == "none":
        return None
    elif crop_preset == "wechat-chat":
        width, height = image_size(image_path)
        region = CropRegion(
            x=round(width * 0.1786),
            y=round(height * 0.0356),
            width=round(width * 0.8135),
            height=round(height * 0.9012),
        )
    else:
        raise ValueError(f"unknown crop preset: {crop_preset}")
    _validate_region_inside_image(region, image_size(image_path))
    return region


def crop_image(image_path: Path | str, region: CropRegion) -> None:
    path = Path(image_path)
    temp_path = path.with_name(f"{path.stem}.crop{path.suffix}")
    result = subprocess.run(
        [
            "sips",
            "-c",
            str(region.height),
            str(region.width),
            "--cropOffset",
            str(region.y),
            str(region.x),
            str(path),
            "--out",
            str(temp_path),
        ],
        text=True,
        capture_output=True,
    )
    if result.returncode != 0:
        raise CaptureError(result.stderr.strip() or "failed to crop image")
    temp_path.replace(path)


def frontmost_app_name() -> str | None:
    return frontmost_app_status().name


def frontmost_app_status() -> FrontmostAppStatus:
    swift_status = _frontmost_app_from_swift()
    if swift_status.name:
        return swift_status
    fallback_status = _frontmost_app_from_osascript()
    if fallback_status.name:
        return fallback_status
    return FrontmostAppStatus(
        name=None,
        method=f"{swift_status.method}+{fallback_status.method}",
        detail=f"{swift_status.detail}; {fallback_status.detail}",
    )


def _frontmost_app_from_swift() -> FrontmostAppStatus:
    if platform.system() != "Darwin":
        return FrontmostAppStatus(name=None, method="swift", detail="not macOS")
    try:
        binary = ensure_frontmost_helper()
    except Exception as exc:
        return FrontmostAppStatus(name=None, method="swift", detail=str(exc))
    result = subprocess.run([str(binary)], text=True, capture_output=True)
    if result.returncode == 0:
        name = result.stdout.strip()
        if name:
            return FrontmostAppStatus(name=name, method="swift", detail="ok")
    detail = result.stderr.strip() or result.stdout.strip() or "frontmost helper failed"
    return FrontmostAppStatus(name=None, method="swift", detail=detail)


def _frontmost_app_from_osascript() -> FrontmostAppStatus:
    script = 'tell application "System Events" to get name of first application process whose frontmost is true'
    try:
        result = subprocess.run(["osascript", "-e", script], text=True, capture_output=True)
    except OSError as exc:
        return FrontmostAppStatus(name=None, method="osascript", detail=f"osascript unavailable: {exc}")
    if result.returncode == 0:
        name = result.stdout.strip()
        if name:
            return FrontmostAppStatus(name=name, method="osascript", detail="ok")
    detail = result.stderr.strip() or result.stdout.strip() or "osascript failed"
    return FrontmostAppStatus(name=None, method="osascript", detail=detail)


def _validate_positive_region(region: CropRegion) -> None:
    if region.x < 0 or region.y < 0 or region.width <= 0 or region.height <= 0:
        raise ValueError("crop values must describe a positive region")


def _validate_region_inside_image(region: CropRegion, size: tuple[int, int]) -> None:
    _validate_positive_region(region)
    image_width, image_height = size
    if region.x + region.width > image_width or region.y + region.height > image_height:
        raise ValueError("crop region is outside the image bounds")


def _needs_build(source: Path, binary: Path) -> bool:
    if not binary.exists():
        return True
    return source.stat().st_mtime > binary.stat().st_mtime
