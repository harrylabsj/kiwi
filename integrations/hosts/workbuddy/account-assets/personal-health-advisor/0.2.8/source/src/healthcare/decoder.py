from __future__ import annotations

import shutil
import stat
import subprocess
import hashlib
import json
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Callable


class DecoderError(RuntimeError):
    """A decoder rejected or could not safely process an input document."""


class DecoderUnavailable(DecoderError):
    """The requested local decoder or OCR language is not installed."""


@dataclass(frozen=True, slots=True)
class DecoderLimits:
    max_input_bytes: int = 25 * 1024 * 1024
    # Real personal reports (blood-pressure logs, annual exam booklets) are
    # routinely longer than 20 pages; the bound still prevents runaway input.
    max_pages: int = 100
    timeout_seconds: float = 15.0
    max_output_chars: int = 2_000_000


@dataclass(frozen=True, slots=True)
class DecodedPage:
    page_number: int
    text: str
    media_type: str
    decoder: str


@dataclass(frozen=True, slots=True)
class DecodedDocument:
    filename: str
    media_type: str
    pages: tuple[DecodedPage, ...]
    decoder: str
    source_sha256: str | None = None
    source_size_bytes: int | None = None


def _source_metadata(path: Path) -> tuple[str, int]:
    raw = path.read_bytes()
    return hashlib.sha256(raw).hexdigest(), len(raw)


class TextDecoder:
    def __init__(self, limits: DecoderLimits | None = None) -> None:
        self.limits = limits or DecoderLimits()

    def decode(self, path: Path) -> DecodedDocument:
        _validate_regular_file(path, {".txt", ".text", ".md", ".markdown"}, self.limits)
        try:
            raw = path.read_bytes()
            text = raw.decode("utf-8")
        except (OSError, UnicodeDecodeError) as exc:
            raise DecoderError("text fixture is not valid UTF-8") from exc
        if len(text) > self.limits.max_output_chars:
            raise DecoderError("decoder output size exceeds the configured limit")
        digest, size = _source_metadata(path)
        return DecodedDocument(
            path.name,
            "text/plain",
            (DecodedPage(1, text, "text/plain", "utf8-text"),),
            "utf8-text",
            digest,
            size,
        )


def _validate_regular_file(path: Path, suffixes: set[str], limits: DecoderLimits) -> None:
    if limits.max_input_bytes < 1 or limits.max_pages < 1 or limits.max_output_chars < 1:
        raise DecoderError("decoder limits must be positive")
    try:
        metadata = path.lstat()
    except OSError as exc:
        raise DecoderError("decoder input is not readable") from exc
    if stat.S_ISLNK(metadata.st_mode):
        raise DecoderError("decoder does not accept symbolic links")
    if not stat.S_ISREG(metadata.st_mode):
        raise DecoderError("decoder input must be a regular file")
    if metadata.st_size > limits.max_input_bytes:
        raise DecoderError("decoder input exceeds the configured size limit")
    if path.suffix.casefold() not in suffixes:
        raise DecoderError("decoder does not support this file type")


def _quote_profile_path(path: str) -> str:
    return path.replace("\\", "\\\\").replace('"', '\\"')


def sandbox_profile(command: list[str], input_path: Path | None = None) -> str:
    """Build a read-only, no-network macOS profile for one decoder process.

    macOS ``system.sb`` default-deny blocks reading user-selected reports even
    with explicit file-read rules, so the profile uses ``allow default`` with
    network and file writes denied — the same tradeoff the Vision profile
    makes. The broad read scope is recorded as a Phase 1A1 hardening gate; the
    decoder never writes and never touches the network.
    """
    command_path = _quote_profile_path(str(Path(command[0]).resolve()))
    return "".join(
        [
            "(version 1)\n",
            '(import "system.sb")\n',
            "(allow default)\n",
            "(deny network*)\n",
            "(deny file-write*)\n",
            f'(allow process-exec (literal "{command_path}"))\n',
        ]
    )


def vision_sandbox_profile(command: list[str], input_path: Path | None = None) -> str:
    """Compatibility profile for Vision's system recognition services.

    Vision requires broader system-service access than Poppler/Tesseract. It
    still cannot use the network or write files, but its read scope remains a
    follow-up hardening task.
    """
    command_path = _quote_profile_path(str(Path(command[0]).resolve()))
    return "".join(
        [
            "(version 1)\n",
            '(import "system.sb")\n',
            "(allow default)\n",
            "(deny network*)\n",
            "(deny file-write*)\n",
            f'(allow process-exec (literal "{command_path}"))\n',
        ]
    )


def _sandbox_command(
    command: list[str],
    input_path: Path | None,
    enabled: bool,
    profile_factory: Callable[[list[str], Path | None], str] = sandbox_profile,
) -> list[str]:
    if not enabled:
        return command
    if sys.platform != "darwin":
        return command
    sandbox = shutil.which("sandbox-exec")
    if not sandbox:
        raise DecoderUnavailable("macOS sandbox-exec is not installed")
    return [sandbox, "-p", profile_factory(command, input_path), *command]


def _run_checked(
    command: list[str],
    limits: DecoderLimits,
    error_message: str,
    *,
    input_path: Path | None = None,
    sandbox: bool = True,
    profile_factory: Callable[[list[str], Path | None], str] = sandbox_profile,
) -> str:
    command = _sandbox_command(command, input_path, sandbox, profile_factory)
    try:
        result = subprocess.run(
            command,
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=limits.timeout_seconds,
        )
    except FileNotFoundError as exc:
        raise DecoderUnavailable(f"decoder executable is not installed: {command[0]}") from exc
    except subprocess.TimeoutExpired as exc:
        raise DecoderError("decoder timed out") from exc
    except OSError as exc:
        raise DecoderError(error_message) from exc
    if result.returncode != 0:
        raise DecoderError(error_message)
    if len(result.stdout) > limits.max_output_chars:
        raise DecoderError("decoder output size exceeds the configured limit")
    return result.stdout


class PdfTextDecoder:
    """Decode text PDFs through bounded Poppler subprocesses.

    It intentionally does not claim to OCR scanned PDFs. Empty text is an
    explicit handoff to the future rasterizer/OCR adapter.
    """

    def __init__(
        self,
        limits: DecoderLimits | None = None,
        pdfinfo_command: str = "pdfinfo",
        pdftotext_command: str = "pdftotext",
        sandbox: bool | None = None,
    ) -> None:
        self.limits = limits or DecoderLimits()
        self.pdfinfo_command = pdfinfo_command
        self.pdftotext_command = pdftotext_command
        self.sandbox = sys.platform == "darwin" if sandbox is None else sandbox

    def available(self) -> bool:
        return bool(shutil.which(self.pdfinfo_command) and shutil.which(self.pdftotext_command))

    def _page_count(self, path: Path) -> int:
        output = _run_checked(
            [self.pdfinfo_command, str(path)],
            self.limits,
            "unable to inspect PDF metadata",
            input_path=path,
            sandbox=self.sandbox,
        )
        for line in output.splitlines():
            if line.lower().startswith("pages:"):
                try:
                    pages = int(line.split(":", 1)[1].strip())
                except ValueError as exc:
                    raise DecoderError("PDF page count is invalid") from exc
                if pages < 1 or pages > self.limits.max_pages:
                    raise DecoderError("PDF page count exceeds the configured limit")
                return pages
        raise DecoderError("PDF metadata did not include a page count")

    def decode(self, path: Path) -> DecodedDocument:
        _validate_regular_file(path, {".pdf"}, self.limits)
        if not self.available():
            raise DecoderUnavailable("Poppler pdfinfo/pdftotext is not installed")
        pages = self._page_count(path)
        output = _run_checked(
            [self.pdftotext_command, "-layout", str(path), "-"],
            self.limits,
            "unable to extract text from PDF",
            input_path=path,
            sandbox=self.sandbox,
        )
        chunks = output.split("\f")
        if chunks and not chunks[-1].strip():
            chunks.pop()
        if not any(chunk.strip() for chunk in chunks):
            raise DecoderError("PDF contains no extractable text; OCR is required")
        if len(chunks) > pages:
            chunks = chunks[:pages]
        decoded_pages = tuple(
            DecodedPage(index, text, "text/plain", "poppler-pdftotext")
            for index, text in enumerate(chunks, start=1)
        )
        digest, size = _source_metadata(path)
        return DecodedDocument(path.name, "application/pdf", decoded_pages, "poppler-pdftotext", digest, size)


class TesseractOcrAdapter:
    """Bounded local OCR adapter; unavailable languages fail closed."""

    def __init__(
        self,
        languages: tuple[str, ...] = ("chi_sim", "eng"),
        limits: DecoderLimits | None = None,
        command: str = "tesseract",
        sandbox: bool | None = None,
    ) -> None:
        self.languages = languages
        self.limits = limits or DecoderLimits()
        self.command = command
        self.sandbox = sys.platform == "darwin" if sandbox is None else sandbox

    def available(self) -> bool:
        return bool(shutil.which(self.command))

    def installed_languages(self) -> set[str]:
        if not self.available():
            raise DecoderUnavailable("Tesseract is not installed")
        output = _run_checked(
            [self.command, "--list-langs"],
            self.limits,
            "unable to inspect installed OCR languages",
            sandbox=self.sandbox,
        )
        return {line.strip() for line in output.splitlines() if line.strip() and not line.startswith("List of")}

    def decode_image(self, path: Path) -> DecodedDocument:
        _validate_regular_file(path, {".png", ".jpg", ".jpeg", ".webp", ".tif", ".tiff"}, self.limits)
        languages = self.installed_languages()
        missing = sorted(set(self.languages) - languages)
        if missing:
            raise DecoderUnavailable(f"OCR language pack is not installed: {', '.join(missing)}")
        output = _run_checked(
            [self.command, str(path), "stdout", "-l", "+".join(self.languages), "--psm", "6"],
            self.limits,
            "unable to OCR image",
            input_path=path,
            sandbox=self.sandbox,
        )
        if not output.strip():
            raise DecoderError("OCR produced no text")
        page = DecodedPage(1, output, "text/plain", f"tesseract:{'+'.join(self.languages)}")
        digest, size = _source_metadata(path)
        return DecodedDocument(path.name, "image/*", (page,), page.decoder, digest, size)


class VisionOcrAdapter:
    """macOS Vision OCR adapter for Chinese + English local recognition."""

    def __init__(
        self,
        command: str | Path = "healthcare-vision-ocr",
        limits: DecoderLimits | None = None,
        sandbox: bool | None = None,
    ) -> None:
        self.command = str(command)
        self.limits = limits or DecoderLimits()
        self.sandbox = sys.platform == "darwin" if sandbox is None else sandbox

    def available(self) -> bool:
        return bool(shutil.which(self.command) or Path(self.command).is_file())

    def decode_image(self, path: Path) -> DecodedDocument:
        _validate_regular_file(path, {".png", ".jpg", ".jpeg", ".webp", ".tif", ".tiff"}, self.limits)
        if not self.available():
            raise DecoderUnavailable("Apple Vision OCR helper is not built")
        output = _run_checked(
            [self.command, str(path)],
            self.limits,
            "unable to run Apple Vision OCR",
            input_path=path,
            sandbox=self.sandbox,
            profile_factory=vision_sandbox_profile,
        )
        try:
            result = json.loads(output)
            text = str(result["text"])
            blocks = result.get("blocks", [])
        except (KeyError, TypeError, ValueError) as exc:
            raise DecoderError("Apple Vision OCR returned an invalid result") from exc
        if not text.strip():
            raise DecoderError("OCR produced no text")
        if not isinstance(blocks, list):
            raise DecoderError("Apple Vision OCR returned invalid blocks")
        page = DecodedPage(1, text, "text/plain", "apple-vision")
        digest, size = _source_metadata(path)
        return DecodedDocument(path.name, "image/*", (page,), "apple-vision", digest, size)


def decode_file(
    path: Path,
    ocr_languages: tuple[str, ...] = ("chi_sim", "eng"),
    ocr_engine: str = "vision",
    ocr_command: str | Path = "healthcare-vision-ocr",
    sandbox: bool | None = None,
) -> DecodedDocument:
    suffix = path.suffix.casefold()
    if suffix in {".txt", ".text", ".md", ".markdown"}:
        return TextDecoder().decode(path)
    if suffix == ".pdf":
        return PdfTextDecoder(sandbox=sandbox).decode(path)
    if ocr_engine == "vision":
        return VisionOcrAdapter(ocr_command, sandbox=sandbox).decode_image(path)
    if ocr_engine == "tesseract":
        return TesseractOcrAdapter(languages=ocr_languages, sandbox=sandbox).decode_image(path)
    raise DecoderError(f"unsupported OCR engine: {ocr_engine}")


def page_digest(page: DecodedPage) -> str:
    return hashlib.sha256(page.text.encode("utf-8")).hexdigest()
