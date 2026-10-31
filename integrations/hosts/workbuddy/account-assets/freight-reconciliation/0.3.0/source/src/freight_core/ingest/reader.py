"""安全文件读取（§6.1）：先校验后解析，全部限额硬性执行。

- 后缀 + 文件头（magic bytes）双重校验；加密/OLE 容器、XLS/XLSM、宏、外部连接拒绝。
- 压缩炸弹防御：zip 解包后总大小与压缩比上限。
- 枚举全部工作表（含隐藏表）与隐藏行/列；隐藏行不默认跳过，仅标记。
- 公式单元格：只采用已存在缓存值并显式标注；无缓存的公式单元格判解析失败。
- 原行号从文件第一行（表头）起算，去除表头不重排。
"""
from __future__ import annotations

import csv
import io
import zipfile
from dataclasses import dataclass, field
from pathlib import Path

from ..domain import (MAX_CELL_TEXT, MAX_DETAIL_ROWS_PER_FILE, MAX_FILE_BYTES,
                      XLSX_MAX_SHEETS)
from ..errors import FeatureUnsupported, InvalidInput, LimitExceeded

XLSX_SUFFIXES = {".xlsx"}
CSV_SUFFIXES = {".csv"}
ZIP_UNCOMPRESSED_CAP = 512 * 1024 * 1024
ZIP_BOMB_RATIO = 200

_OLE_MAGIC = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"  # 加密 MS Office / OLE 容器
_XLSX_MAGIC = b"PK\x03\x04"


@dataclass
class SheetData:
    name: str
    header: list[str]
    rows: list[dict[str, str | None]] = field(default_factory=list)  # 列名 -> 原始文本
    row_numbers: list[int] = field(default_factory=list)  # 文件内 1 起算，表头为 1
    hidden_rows: set[int] = field(default_factory=set)
    hidden: bool = False  # 整表隐藏
    formula_cells: list[str] = field(default_factory=list)  # 使用了缓存值的单元格
    no_cache_formula_cells: list[str] = field(default_factory=list)  # 无缓存 → 所在行失败


@dataclass
class ParsedFile:
    path: str
    container: str  # csv / xlsx
    sha256: str
    byte_size: int
    sheets: list[SheetData]
    warnings: list[str] = field(default_factory=list)
    rejected_reason: str | None = None


def _sha256_file(path: Path) -> str:
    import hashlib
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _check_zip_bomb(path) -> None:
    path = Path(path)
    with zipfile.ZipFile(path) as z:
        total = 0
        for info in z.infolist():
            total += info.file_size
        if total > ZIP_UNCOMPRESSED_CAP:
            raise LimitExceeded(f"Uncompressed content {total} bytes exceeds cap.")
        if path.stat().st_size > 0 and total // max(path.stat().st_size, 1) > ZIP_BOMB_RATIO:
            raise LimitExceeded("Compression ratio exceeds bomb threshold.")


def _validate_container(path: Path, suffix: str) -> None:
    head = path.open("rb").read(8)
    if head.startswith(_OLE_MAGIC):
        raise FeatureUnsupported("Encrypted or legacy OLE container is rejected.")
    if suffix in CSV_SUFFIXES:
        return  # CSV 无容器魔数约束；内容编码错误由解码步骤拒绝
    if suffix in XLSX_SUFFIXES:
        if not head.startswith(_XLSX_MAGIC):
            raise InvalidInput("File header does not match .xlsx container.")
        with zipfile.ZipFile(path) as z:
            names = z.namelist()
        if any(n.endswith("vbaProject.bin") for n in names):
            raise FeatureUnsupported("Macro project detected; macros are rejected.")
        if any(n.startswith("xl/externalLinks") for n in names):
            raise FeatureUnsupported("External data connections are rejected.")


def read_csv_file(path: Path) -> ParsedFile:
    raw = path.read_bytes()
    text = raw.decode("utf-8-sig")  # UTF-8 BOM 容错；无法解码时抛异常拒绝
    lines = text.splitlines()
    if not lines:
        raise InvalidInput("Empty CSV file.")
    reader = csv.reader(io.StringIO(text))
    records = list(reader)
    if len(records) > MAX_DETAIL_ROWS_PER_FILE + 1:
        raise LimitExceeded(f"CSV rows exceed {MAX_DETAIL_ROWS_PER_FILE}.")
    header = [h.strip() for h in records[0]]
    sheet = SheetData(name=path.name, header=header)
    for i, record in enumerate(records[1:], start=2):
        if not any((c or "").strip() for c in record):
            continue  # 全空行不属于明细，也不计入行数
        row = {header[j]: (record[j] if j < len(record) else None)
               for j in range(len(header))}
        sheet.rows.append(row)
        sheet.row_numbers.append(i)
    return ParsedFile(path=str(path), container="csv", sha256=_sha256_file(path),
                      byte_size=len(raw), sheets=[sheet])


def read_xlsx_file(path: Path) -> ParsedFile:
    from openpyxl import load_workbook  # 延迟导入，Core 其余部分不依赖
    _check_zip_bomb(path)
    wb_values = load_workbook(path, data_only=True, read_only=False)
    wb_formulas = load_workbook(path, data_only=False, read_only=False)
    if len(wb_values.sheetnames) > XLSX_MAX_SHEETS:
        raise LimitExceeded("Too many worksheets.")
    parsed = ParsedFile(path=str(path), container="xlsx", sha256=_sha256_file(path),
                        byte_size=path.stat().st_size, sheets=[])
    for name in wb_values.sheetnames:
        ws = wb_values[name]
        wsf = wb_formulas[name]
        sheet = SheetData(name=name, header=[], hidden=(ws.sheet_state != "visible"))
        if sheet.hidden:
            parsed.warnings.append(f"Hidden worksheet included: {name}")
        max_col = ws.max_column or 0
        header_cells: list[str] = []
        for col in range(1, max_col + 1):
            v = ws.cell(row=1, column=col).value
            header_cells.append(str(v).strip() if v is not None else f"列{col}")
        sheet.header = header_cells
        # 隐藏列标记（进 warnings，不静默跳过）
        for letter, dim in getattr(ws, "column_dimensions", {}).items():
            if dim.hidden:
                parsed.warnings.append(f"Hidden column {letter} in sheet {name}")
        max_row = ws.max_row or 1
        if max_row - 1 > MAX_DETAIL_ROWS_PER_FILE:
            raise LimitExceeded(f"Sheet {name} rows exceed {MAX_DETAIL_ROWS_PER_FILE}.")
        for r in range(2, max_row + 1):
            dim = ws.row_dimensions.get(r)
            hidden_row = bool(dim.hidden) if dim is not None else False
            values: dict[str, str | None] = {}
            has_content = False
            row_has_nocache_formula = False
            for col in range(1, max_col + 1):
                header_name = header_cells[col - 1]
                cell_v = ws.cell(row=r, column=col).value
                fcell = wsf.cell(row=r, column=col)
                if fcell.data_type == "f":  # 公式单元格：仅接受已存在缓存值
                    addr = f"{name}!{fcell.coordinate}"
                    if cell_v is None:
                        sheet.no_cache_formula_cells.append(addr)
                        row_has_nocache_formula = True
                    else:
                        sheet.formula_cells.append(addr)
                if cell_v is not None:
                    text_v = str(cell_v)
                    if len(text_v) > MAX_CELL_TEXT:
                        raise LimitExceeded("Cell text exceeds cap.")
                    values[header_name] = text_v
                    has_content = True
            if not has_content:
                continue
            if row_has_nocache_formula:
                # 无缓存公式的行不能进入明细；登记为解析失败行
                sheet.rows.append({"__parse_error__": f"formula without cached value: "
                                                      f"{sheet.no_cache_formula_cells[-1]}"})
                sheet.row_numbers.append(r)
                continue
            if hidden_row:
                sheet.hidden_rows.add(r)
                parsed.warnings.append(f"Hidden row {name}!{r} included (not skipped)")
            sheet.rows.append(values)
            sheet.row_numbers.append(r)
        parsed.sheets.append(sheet)
    return parsed


def read_any(path: str | Path, *, declared_kind: str | None = None) -> ParsedFile:
    p = Path(path)
    if not p.exists():
        raise InvalidInput("File does not exist.")
    size = p.stat().st_size
    if size > MAX_FILE_BYTES:
        raise LimitExceeded(f"File exceeds {MAX_FILE_BYTES} bytes limit.")
    suffix = p.suffix.lower()
    if suffix == ".xls" or suffix == ".xlsm":
        raise FeatureUnsupported(f"{suffix} is rejected; provide xlsx/csv without macros.")
    if suffix in XLSX_SUFFIXES:
        _validate_container(p, suffix)
        return read_xlsx_file(p)
    if suffix in CSV_SUFFIXES:
        _validate_container(p, suffix)
        return read_csv_file(p)
    raise FeatureUnsupported(f"Unsupported file type: {suffix}")
