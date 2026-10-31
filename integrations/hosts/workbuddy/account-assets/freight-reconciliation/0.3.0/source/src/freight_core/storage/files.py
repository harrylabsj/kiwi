"""文件与数据库一致性（§16.3）：staging → 完整写入 → hash → 原子 rename → 事务发布引用。

失败留下未引用 staging 文件可回收，不暴露半成品。
"""
from __future__ import annotations

import hashlib
import os
import shutil
from pathlib import Path


class FileStore:
    def __init__(self, root: str | Path):
        self.root = Path(root)
        self.files = self.root / "files"
        self.staging = self.root / "staging"
        self.files.mkdir(parents=True, exist_ok=True)
        self.staging.mkdir(parents=True, exist_ok=True)

    def ingest_file(self, src: str | Path) -> tuple[str, str]:
        """把用户文件安全收进受管目录：先写 staging，完整校验后原子改名。

        返回 (stored_relative_path, sha256)。
        """
        src = Path(src)
        data = src.read_bytes()
        digest = hashlib.sha256(data).hexdigest()
        name = f"{digest[:2]}/{digest}{src.suffix.lower()}"
        final = self.files / name
        if not final.exists():
            final.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.staging / f"{digest}.tmp"
            tmp.write_bytes(data)
            with open(tmp, "rb") as f:  # 写后校验，防止半截文件
                if hashlib.sha256(f.read()).hexdigest() != digest:
                    tmp.unlink(missing_ok=True)
                    raise IOError("staged file hash mismatch")
            os.replace(tmp, final)  # 同卷原子 rename
        rel = str(Path("files") / name)
        return rel, digest

    def write_output(self, name: str, data: bytes) -> tuple[str, str]:
        """写出导出产物：同样走 staging + 原子 rename。返回 (rel_path, sha256)。"""
        digest = hashlib.sha256(data).hexdigest()
        final = self.files / "exports" / name
        final.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.staging / f"export-{digest}.tmp"
        tmp.write_bytes(data)
        with open(tmp, "rb") as f:
            if hashlib.sha256(f.read()).hexdigest() != digest:
                tmp.unlink(missing_ok=True)
                raise IOError("staged export hash mismatch")
        os.replace(tmp, final)
        return str(Path("files") / "exports" / name), digest

    def resolve(self, rel_path: str) -> Path:
        p = (self.root / rel_path).resolve()
        root = self.root.resolve()
        # 工作区路径白名单：拒绝越界与符号链接逃逸（§20.2）
        if root not in p.parents and p != root:
            raise PermissionError("path escapes workspace whitelist")
        return p

    def collect_garbage(self) -> int:
        """回收未被引用的 staging 残留。返回清理数量。"""
        removed = 0
        for f in self.staging.glob("*"):
            f.unlink(missing_ok=True)
            removed += 1
        return removed

    def integrity_check(self) -> dict:
        files_ok = all(f.stat().st_size > 0 for f in self.files.rglob("*") if f.is_file())
        return {"staging_clean": not any(self.staging.iterdir()), "files_nonempty": files_ok}
