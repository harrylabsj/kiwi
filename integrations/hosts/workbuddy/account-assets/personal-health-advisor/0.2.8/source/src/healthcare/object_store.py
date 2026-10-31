from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import stat
from dataclasses import dataclass
from pathlib import Path

from cryptography.hazmat.primitives.ciphers.aead import AESGCM


class ObjectStoreError(RuntimeError):
    pass


@dataclass(frozen=True, slots=True)
class ObjectRef:
    object_id: str
    media_type: str
    size_bytes: int


_OBJECT_ID = re.compile(r"^[0-9a-f]{64}$")
MAX_OBJECT_BYTES = 25 * 1024 * 1024


def _secure_mode(path: Path) -> None:
    path.chmod(stat.S_IRUSR | stat.S_IWUSR)


class EncryptedObjectStore:
    """Vault-keyed, HMAC-addressed and individually AES-GCM encrypted objects."""

    FORMAT = "healthCare.encrypted-object"
    VERSION = 1

    def __init__(self, root: Path, vault_key: bytes):
        if len(vault_key) != 32:
            raise ObjectStoreError("object store key must be 32 bytes")
        self.root = root
        self.vault_key = vault_key

    def _object_id(self, content: bytes) -> str:
        return hmac.new(self.vault_key, content, hashlib.sha256).hexdigest()

    def _object_key(self, object_id: str) -> bytes:
        return hmac.new(self.vault_key, b"healthCare-object-key-v1:" + object_id.encode("ascii"), hashlib.sha256).digest()

    def _path(self, object_id: str) -> Path:
        if not _OBJECT_ID.fullmatch(object_id):
            raise ObjectStoreError("invalid object id")
        return self.root / object_id[:2] / f"{object_id}.hobj"

    def put(self, content: bytes, media_type: str) -> ObjectRef:
        if not isinstance(content, bytes) or not content:
            raise ObjectStoreError("object content must be non-empty bytes")
        if len(content) > MAX_OBJECT_BYTES:
            raise ObjectStoreError("object exceeds the configured size limit")
        if not media_type.strip():
            raise ObjectStoreError("object media type must not be empty")
        object_id = self._object_id(content)
        destination = self._path(object_id)
        if destination.exists():
            existing = self.get(object_id)
            if not hmac.compare_digest(hashlib.sha256(existing).digest(), hashlib.sha256(content).digest()):
                raise ObjectStoreError("content-addressed object collision detected")
            return ObjectRef(object_id, media_type, len(content))
        nonce = secrets.token_bytes(12)
        aad = f"{self.FORMAT}:v{self.VERSION}:{object_id}:{media_type}".encode("utf-8")
        ciphertext = AESGCM(self._object_key(object_id)).encrypt(nonce, content, aad)
        envelope = {
            "format": self.FORMAT,
            "version": self.VERSION,
            "object_id": object_id,
            "media_type": media_type,
            "size_bytes": len(content),
            "nonce": base64.b64encode(nonce).decode("ascii"),
            "ciphertext": base64.b64encode(ciphertext).decode("ascii"),
        }
        destination.parent.mkdir(parents=True, exist_ok=True)
        temporary = destination.with_name(f".{destination.name}.{secrets.token_hex(6)}.tmp")
        temporary.write_text(json.dumps(envelope, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        _secure_mode(temporary)
        os.replace(temporary, destination)
        _secure_mode(destination)
        return ObjectRef(object_id, media_type, len(content))

    def get(self, object_id: str) -> bytes:
        path = self._path(object_id)
        try:
            envelope = json.loads(path.read_text(encoding="utf-8"))
            if envelope.get("format") != self.FORMAT or envelope.get("version") != self.VERSION:
                raise ObjectStoreError("unsupported encrypted object")
            if envelope.get("object_id") != object_id:
                raise ObjectStoreError("object id mismatch")
            media_type = str(envelope["media_type"])
            nonce = base64.b64decode(envelope["nonce"])
            ciphertext = base64.b64decode(envelope["ciphertext"])
            aad = f"{self.FORMAT}:v{self.VERSION}:{object_id}:{media_type}".encode("utf-8")
            content = AESGCM(self._object_key(object_id)).decrypt(nonce, ciphertext, aad)
        except ObjectStoreError:
            raise
        except Exception as exc:
            raise ObjectStoreError("unable to decrypt object") from exc
        if not hmac.compare_digest(self._object_id(content), object_id):
            raise ObjectStoreError("object integrity check failed")
        if int(envelope.get("size_bytes", -1)) != len(content):
            raise ObjectStoreError("object size check failed")
        return content

    def metadata(self, object_id: str) -> ObjectRef:
        path = self._path(object_id)
        try:
            envelope = json.loads(path.read_text(encoding="utf-8"))
            if envelope.get("format") != self.FORMAT or envelope.get("version") != self.VERSION:
                raise ObjectStoreError("unsupported encrypted object")
            return ObjectRef(object_id, str(envelope["media_type"]), int(envelope["size_bytes"]))
        except ObjectStoreError:
            raise
        except Exception as exc:
            raise ObjectStoreError("unable to read object metadata") from exc

    def delete(self, object_id: str) -> None:
        path = self._path(object_id)
        try:
            path.unlink()
        except FileNotFoundError:
            return
        except OSError as exc:
            raise ObjectStoreError("unable to delete object") from exc
