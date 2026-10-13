#!/usr/bin/env python3
"""Offline validation for the 17-item Kiwi Buddy submission evidence registry."""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
import re
import stat
from pathlib import Path, PurePosixPath
from zipfile import ZipFile


REGISTRY_REL = "integrations/hosts/workbuddy/kiwi-merchant-buddy/review-assets/registry.json"
EXPECTED_COUNTS = {"skill": 10, "expert": 5, "team": 1, "connector": 1}


def repo_root() -> Path:
    for parent in Path(__file__).resolve().parents:
        if (parent / ".git").exists():
            return parent
    raise RuntimeError("Could not locate repository root")


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def path_for(root: Path, value: str) -> Path:
    rel = PurePosixPath(value)
    if rel.is_absolute() or not rel.parts or any(part in ("", ".", "..") for part in rel.parts) or "\\" in value:
        raise ValueError(f"path is not a safe repository-relative path: {value!r}")
    return root.joinpath(*rel.parts)


def text_values(value: object):
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for item in value.values():
            yield from text_values(item)
    elif isinstance(value, list):
        for item in value:
            yield from text_values(item)


def walk_dicts(value: object):
    if isinstance(value, dict):
        yield value
        for item in value.values():
            yield from walk_dicts(item)
    elif isinstance(value, list):
        for item in value:
            yield from walk_dicts(item)


def has_coherent_skill_status_record(listing: str, name: str, version: str, review_id: str) -> bool:
    lines = listing.splitlines()
    heading = f'heading "{name}"'
    blocks: list[list[str]] = []
    for i, line in enumerate(lines):
        if heading in line:
            block: list[str] = []
            for candidate in lines[i + 1:]:
                if 'heading "' in candidate:
                    break
                block.append(candidate.strip())
            blocks.append(block)
    expected = f'StaticText "公开 · v{version} · {review_id}"'
    return sum('StaticText "已发布"' in block and expected in block for block in blocks) == 1


def outcome(errors: list[str]) -> tuple[str, int]:
    return ("PASS", 0) if not errors else ("FAIL", 1)


def validate(root: Path, registry: dict[str, object]) -> list[str]:
    errors: list[str] = []
    entries = registry.get("entries")
    if not isinstance(entries, list):
        return ["registry.entries must be an array"]
    if registry.get("schema") != "kiwi.buddy.review-assets/1":
        errors.append("unsupported registry schema")
    if len(entries) != 17 or registry.get("itemCount") != 17:
        errors.append("registry must contain exactly 17 entries")

    counts: dict[str, int] = {}
    slugs: set[str] = set()
    review_ids: set[str] = set()
    market_ids: set[str] = set()
    review_prefix = {"skill": "os_", "expert": "oe_", "team": "oe_", "connector": "oc_"}
    receipt_ledger_rel = "integrations/hosts/workbuddy/kiwi-merchant-buddy/review-assets/official/2026-10-13/seven-new-skill-submission-ledger.json"
    receipt_rows: list[dict[str, object]] = []
    try:
        receipt_rows = json.loads(path_for(root, receipt_ledger_rel).read_text(encoding="utf-8"))
        if not isinstance(receipt_rows, list):
            raise ValueError("ledger root must be an array")
    except Exception as exc:
        errors.append(f"seven-skill receipt ledger invalid: {exc}")
    receipt_by_slug = {row.get("slug"): row for row in receipt_rows if isinstance(row, dict)}
    for entry in entries:
        if not isinstance(entry, dict):
            errors.append("registry entry must be an object")
            continue
        slug = entry.get("slug")
        kind = entry.get("kind")
        counts[str(kind)] = counts.get(str(kind), 0) + 1
        if not isinstance(slug, str) or not slug:
            errors.append("entry slug missing")
        elif slug in slugs:
            errors.append(f"duplicate slug: {slug}")
        else:
            slugs.add(slug)

        refs = entry.get("references")
        if not isinstance(refs, dict):
            errors.append(f"{slug}: references missing")
            refs = {}
        rid = refs.get("reviewAssetId")
        if not isinstance(rid, str) or not rid.startswith(review_prefix.get(str(kind), "__invalid__")):
            errors.append(f"{slug}: reviewAssetId missing or wrong namespace")
        elif rid in review_ids:
            errors.append(f"duplicate reviewAssetId: {rid}")
        else:
            review_ids.add(rid)
        mid = refs.get("marketReferenceId")
        if mid is not None:
            allowed = ((kind in ("expert", "team") and isinstance(mid, str) and mid.startswith("ex_")) or
                       (kind == "skill" and isinstance(mid, str) and mid.startswith("skill_")) or
                       (kind == "connector" and mid == "kiwi-merchant"))
            if not allowed:
                errors.append(f"{slug}: marketReferenceId uses the wrong namespace: {mid!r}")
            if mid == rid:
                errors.append(f"{slug}: reviewAssetId and marketReferenceId were conflated")
            if isinstance(mid, str):
                if mid in market_ids:
                    errors.append(f"duplicate marketReferenceId: {mid}")
                market_ids.add(mid)

        snapshot = entry.get("statusSnapshot")
        if not isinstance(snapshot, dict) or "observedAtUtc" not in snapshot or not snapshot.get("snapshotDate"):
            errors.append(f"{slug}: status must include a bounded observation date and observedAtUtc (nullable)")
        elif snapshot.get("evidencePath"):
            evidence = path_for(root, snapshot["evidencePath"])
            if not evidence.is_file():
                errors.append(f"{slug}: status evidence missing: {snapshot['evidencePath']}")
        if kind == "skill" and slug == "kiwi-merchant-cs-prep":
            expected_list = "integrations/hosts/workbuddy/kiwi-merchant-buddy/review-assets/official/2026-10-13/current-ten-skill-list-observation.txt"
            if not isinstance(snapshot, dict) or snapshot.get("evidencePath") != expected_list:
                errors.append("kiwi-merchant-cs-prep: status evidence must point to the current ten-skill list")
            else:
                listing = path_for(root, expected_list).read_text(encoding="utf-8")
                if not has_coherent_skill_status_record(listing, entry.get("name", ""), entry.get("version", ""), refs.get("reviewAssetId", "")) or snapshot.get("value") != "published":
                    errors.append("kiwi-merchant-cs-prep: current status snapshot must bind ID/version/published in one record and say published")
        if kind == "skill" and slug in receipt_by_slug:
            row = receipt_by_slug[slug]
            if not isinstance(snapshot, dict) or snapshot.get("evidencePath") != receipt_ledger_rel:
                errors.append(f"{slug}: status evidence must point to the seven-skill receipt ledger")
            else:
                rid = refs.get("reviewAssetId")
                if row.get("assetId") != rid or row.get("version") != entry.get("version"):
                    errors.append(f"{slug}: seven-skill receipt ledger ID/version mismatch")
                if row.get("status") != "审核中":
                    errors.append(f"{slug}: seven-skill receipt ledger status is not under review")
                if snapshot.get("value") != "under_review":
                    errors.append(f"{slug}: seven-skill status snapshot disagrees with receipt ledger")
                if snapshot.get("observedAtUtc") != row.get("submittedAtObserved"):
                    errors.append(f"{slug}: observation timestamp differs from receipt ledger")
                if "observation time, not platform submission UTC" not in snapshot.get("timeMeaning", ""):
                    errors.append(f"{slug}: receipt timestamp must be described as observed time, not platform submission UTC")
        submission = entry.get("submission")
        if not isinstance(submission, dict):
            errors.append(f"{slug}: submission metadata missing")
            continue
        archive_rel = submission.get("archivePath")
        if not isinstance(archive_rel, str):
            errors.append(f"{slug}: submission archivePath missing")
            continue
        archive_path = path_for(root, archive_rel)
        if not archive_path.is_file():
            errors.append(f"{slug}: exact submission ZIP missing: {archive_rel}")
            continue
        if sha(archive_path.read_bytes()) != submission.get("sha256"):
            errors.append(f"{slug}: exact submission ZIP SHA mismatch")
        origin = submission.get("originPath")
        if submission.get("originPathKind") == "external exact-source path; verify bytes by sha256":
            origin_path = Path(origin) if isinstance(origin, str) else Path("/") / "invalid-origin"
            if not origin_path.is_file():
                errors.append(f"{slug}: external exact source path is not readable: {origin}")
            elif sha(origin_path.read_bytes()) != submission.get("sha256"):
                errors.append(f"{slug}: external exact source SHA differs from archived submission")

        expected_members = entry.get("packageMembers", [])
        expected_by_name = {m.get("archiveMember"): m for m in expected_members if isinstance(m, dict)}
        try:
            with ZipFile(archive_path) as archive:
                infos = [i for i in archive.infolist() if not i.is_dir()]
                actual_files = {i.filename: i for i in infos}
                if len(actual_files) != len(infos):
                    errors.append(f"{slug}: original ZIP contains duplicate member paths")
                if set(actual_files) != set(expected_by_name):
                    errors.append(f"{slug}: registry member list differs from original ZIP")
                for member_name, info in actual_files.items():
                    member_path = PurePosixPath(member_name)
                    mode = (info.external_attr >> 16) & 0xFFFF
                    if member_path.is_absolute() or any(p in ("", ".", "..") for p in member_path.parts) or "\\" in member_name:
                        errors.append(f"{slug}: unsafe original ZIP member path: {member_name!r}")
                    if stat.S_ISLNK(mode):
                        errors.append(f"{slug}: original ZIP contains a symlink: {member_name}")
                    if member_name not in expected_by_name:
                        continue
                    member = expected_by_name[member_name]
                    data = archive.read(info)
                    if sha(data) != member.get("sha256") or len(data) != member.get("bytes"):
                        errors.append(f"{slug}: ZIP member hash/size mismatch: {member_name}")
                    canonical = path_for(root, member.get("repositoryPath", ""))
                    if not canonical.is_file():
                        errors.append(f"{slug}: canonical member missing: {member.get('repositoryPath')}")
                    elif canonical.read_bytes() != data:
                        errors.append(f"{slug}: canonical member differs from original ZIP: {member_name}")
        except Exception as exc:  # malformed ZIPs are validation failures, not crashes
            errors.append(f"{slug}: invalid ZIP: {exc}")

        artifact_rel = entry.get("artifactPath")
        if not isinstance(artifact_rel, str):
            errors.append(f"{slug}: artifactPath missing")
            continue
        artifact = path_for(root, artifact_rel)

        if kind in ("expert", "team"):
            manifest_path = artifact / ".codebuddy-plugin" / "plugin.json"
            if not manifest_path.is_file():
                errors.append(f"{slug}: hidden plugin manifest missing")
                continue
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            if manifest.get("name") != slug or manifest.get("version") != entry.get("version"):
                errors.append(f"{slug}: plugin manifest identity/version mismatch")
            declared_skills = manifest.get("skills", [])
            if declared_skills != entry.get("embeddedSkillRefs", []):
                errors.append(f"{slug}: embedded skill references differ from registry")
            for ref in manifest.get("agents", []) + declared_skills:
                clean = ref[2:] if ref.startswith("./") else ref
                if not (artifact / clean).is_file() and not (artifact / clean).is_dir():
                    errors.append(f"{slug}: missing embedded reference: {ref}")
            for member in manifest.get("members", []):
                avatar_ref = member.get("avatar")
                if avatar_ref and not (artifact / avatar_ref).is_file():
                    errors.append(f"{slug}: missing team member avatar: {avatar_ref}")
            connectors = manifest.get("dependencies", {}).get("connectors", [])
            if any(c != "kiwi-merchant" for c in connectors):
                errors.append(f"{slug}: unexpected connector dependency reference")
            expected_files = {m["archiveMember"] for m in expected_members}
            actual_files = {str(p.relative_to(artifact)).replace("\\", "/") for p in artifact.rglob("*") if p.is_file()}
            if actual_files != expected_files:
                errors.append(f"{slug}: extracted bundle file set differs from exact submitted ZIP")

        for avatar in entry.get("avatars", []):
            avatar_path = path_for(root, avatar.get("path", ""))
            if not avatar_path.is_file():
                errors.append(f"{slug}: avatar missing: {avatar.get('path')}")
            elif sha(avatar_path.read_bytes()) != avatar.get("sha256"):
                errors.append(f"{slug}: avatar SHA mismatch: {avatar.get('path')}")

    if counts != EXPECTED_COUNTS:
        errors.append(f"kind counts mismatch: expected {EXPECTED_COUNTS}, got {counts}")
    if registry.get("countsByKind") != EXPECTED_COUNTS:
        errors.append("registry.countsByKind does not match required 10 skill / 5 expert / 1 team / 1 connector")

    # Check official exports and market-reference namespaces against their actual contents.
    app = registry.get("application", {})
    current_path = path_for(root, app.get("currentDraft", {}).get("path", ""))
    if not current_path.is_file():
        errors.append("current unsent application draft ZIP missing")
        market: dict[str, object] = {}
    else:
        try:
            with ZipFile(current_path) as archive:
                market_name = next((n for n in archive.namelist() if n.endswith("/market.json")), None)
                config_name = next((n for n in archive.namelist() if n.endswith("/industry-config.json")), None)
                if not market_name:
                    errors.append("current application draft ZIP has no market.json")
                    market = {}
                else:
                    market = json.loads(archive.read(market_name))
                config_text = archive.read(config_name).decode("utf-8") if config_name else ""
                if "dd6d9e9b-9e1b-4cb5-aa40-c9578e15e78e.png" not in config_text:
                    errors.append("current application draft does not contain the recorded bird logo URL")
        except Exception as exc:
            errors.append(f"current application draft ZIP invalid: {exc}")

    refs = [e.get("references", {}) for e in entries if isinstance(e, dict)]
    all_market_ids = {r.get("marketReferenceId") for r in refs if r.get("marketReferenceId") is not None}
    actual_ids = {d.get("id") for d in walk_dicts(market) if isinstance(d.get("id"), str)}
    for entry in entries:
        refs_obj = entry.get("references", {})
        mid = refs_obj.get("marketReferenceId")
        evidence = refs_obj.get("marketReferenceEvidence") or {}
        older = entry.get("existingMarketReferenceSnapshot")
        if isinstance(older, dict) and older.get("marketReferenceId"):
            map_path = path_for(root, older.get("evidencePath", ""))
            if not map_path.is_file():
                errors.append(f"{entry.get('slug')}: earlier market reference evidence missing: {older.get('evidencePath')}")
            else:
                mappings = json.loads(map_path.read_text(encoding="utf-8"))
                if not any(m.get("marketReferenceId") == older["marketReferenceId"] and m.get("reviewAssetId") == refs_obj.get("reviewAssetId") for m in mappings):
                    errors.append(f"{entry.get('slug')}: earlier market reference not evidenced: {older['marketReferenceId']}")
        if mid is None:
            continue
        if mid.startswith("ex_"):
            tag = evidence.get("categoryTagId")
            matches = [d for d in walk_dicts(market) if d.get("tagId") == tag]
            if not matches:
                errors.append(f"{entry.get('slug')}: market category reference missing: {tag}")
            elif not any(mid in {d.get("id") for d in walk_dicts(m)} for m in matches):
                errors.append(f"{entry.get('slug')}: expert market reference absent from its category: {mid}")
        elif mid == "kiwi-merchant" and mid not in actual_ids:
            errors.append("merchant connector market reference absent from current application draft")
        elif mid.startswith("skill_"):
            map_path = path_for(root, f"integrations/hosts/workbuddy/kiwi-merchant-buddy/review-assets/official/2026-10-13/buddy-app-v3-published-skill-reference-map.json")
            if not map_path.is_file():
                errors.append("published skill reference map missing")
            else:
                mappings = json.loads(map_path.read_text(encoding="utf-8"))
                if not any(m.get("marketReferenceId") == mid and m.get("reviewAssetId") == entry.get("references", {}).get("reviewAssetId") for m in mappings):
                    errors.append(f"{entry.get('slug')}: skill market reference not evidenced by published mapping: {mid}")

    for official in registry.get("officialEvidence", []):
        p = path_for(root, official.get("path", ""))
        if not p.is_file():
            errors.append(f"official/history evidence missing: {official.get('path')}")
        elif sha(p.read_bytes()) != official.get("sha256") or p.stat().st_size != official.get("bytes"):
            errors.append(f"official/history evidence hash or size mismatch: {official.get('path')}")

    path_map_rel = "integrations/hosts/workbuddy/kiwi-merchant-buddy/review-assets/official/2026-10-13/seven-skill-local-path-map.json"
    try:
        path_map = json.loads(path_for(root, path_map_rel).read_text(encoding="utf-8"))
        ledger_rows = json.loads(path_for(root, receipt_ledger_rel).read_text(encoding="utf-8"))
        if path_map.get("sourceLedger", {}).get("sha256") != sha(path_for(root, receipt_ledger_rel).read_bytes()):
            errors.append("seven-skill local path map points at a different raw ledger SHA")
        if len(path_map.get("rows", [])) != 7:
            errors.append("seven-skill local path map must contain seven rows")
        for mapped in path_map.get("rows", []):
            original = next((r for r in ledger_rows if r.get("slug") == mapped.get("slug")), None)
            if original is None or mapped.get("reviewAssetId") != original.get("assetId") or mapped.get("version") != original.get("version"):
                errors.append(f"{mapped.get('slug')}: local path map does not match raw ledger ID/version")
                continue
            if mapped.get("rawLedgerReceiptField") != original.get("receipt") or mapped.get("rawLedgerAvatarField") != original.get("avatar"):
                errors.append(f"{mapped.get('slug')}: local path map changed historical raw path fields")
            entry = next((e for e in entries if e.get("slug") == mapped.get("slug")), {})
            avatar = mapped.get("avatar", {})
            if avatar.get("repositoryPath") not in [a.get("path") for a in entry.get("avatars", [])]:
                errors.append(f"{mapped.get('slug')}: local path map avatar path is not its registered package avatar")
            else:
                avatar_path = path_for(root, avatar["repositoryPath"])
                if not avatar_path.is_file() or sha(avatar_path.read_bytes()) != avatar.get("sha256"):
                    errors.append(f"{mapped.get('slug')}: local avatar mapping hash mismatch")
            receipt = mapped.get("receipt", {})
            if receipt.get("repositoryPath"):
                receipt_path = path_for(root, receipt["repositoryPath"])
                if not receipt_path.is_file() or sha(receipt_path.read_bytes()) != receipt.get("sha256") or receipt_path.stat().st_size != receipt.get("bytes"):
                    errors.append(f"{mapped.get('slug')}: local receipt mapping hash/size mismatch")
            elif not str(receipt.get("status", "")).startswith("not_found_at_capture"):
                errors.append(f"{mapped.get('slug')}: receipt missing without an explicit evidence gap")
    except Exception as exc:
        errors.append(f"seven-skill local path mapping invalid: {exc}")

    if app.get("currentDraft", {}).get("submissionStatus") != "saved locally; not resubmitted":
        errors.append("current application draft must remain explicitly marked unsent")
    if not app.get("currentDraft", {}).get("e2ePaused"):
        errors.append("application/platform E2E must remain paused")
    if app.get("currentDraft", {}).get("pendingAssetsSelectable") is not False:
        errors.append("pending assets must not be marked selectable")

    # Portfolio is a bounded snapshot for the exact connector artifact, not an active platform poll.
    try:
        portfolio = json.loads((root / "portfolio-products.json").read_text(encoding="utf-8"))
        product = next(p for p in portfolio["products"] if p.get("id") == "workbuddy-merchant-connector")
        connector = next(e for e in entries if e.get("kind") == "connector")
        if product.get("platform_asset_id") != connector["references"]["reviewAssetId"]:
            errors.append("portfolio connector review ID differs from the registry")
        expected_release_artifact = "release/workbuddy/kiwi-merchant-gateway-connector-1.2.0.zip"
        if product.get("artifact") != expected_release_artifact:
            errors.append("portfolio connector artifact must preserve the release/ artifact contract")
        if product.get("submission_archive") != connector["submission"]["archivePath"]:
            errors.append("portfolio connector submission_archive must point at the exact archived submission ZIP")
        if "snapshot only; not live" not in product.get("state", ""):
            errors.append("portfolio connector state must be bounded as a snapshot")
    except Exception as exc:
        errors.append(f"portfolio connector snapshot invalid: {exc}")

    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--registry", type=Path, help="alternate registry JSON; defaults to the repository registry")
    parser.add_argument("--self-test", action="store_true", help="also inject a missing market reference and confirm rejection")
    args = parser.parse_args()
    root = repo_root()
    registry_path = args.registry.resolve() if args.registry else root / REGISTRY_REL
    registry = json.loads(registry_path.read_text(encoding="utf-8"))
    errors = validate(root, registry)
    result: dict[str, object] = {
        "registry": str(registry_path.relative_to(root)) if registry_path.is_relative_to(root) else str(registry_path),
        "itemCount": len(registry.get("entries", [])),
        "errors": errors,
    }
    if args.self_test and not errors:
        probes: list[tuple[str, bool, str]] = []

        injected = copy.deepcopy(registry)
        candidate = next(e for e in injected["entries"] if e["kind"] == "expert")
        injected_id = "ex_intentionally_missing"
        candidate["references"]["marketReferenceId"] = injected_id
        injected_errors = validate(root, injected)
        probes.append(("negativeMissingReferenceInjection", any(injected_id in e for e in injected_errors), injected_id))

        injected = copy.deepcopy(registry)
        skill_candidate = next(e for e in injected["entries"] if e.get("slug") == "merchant-source-evidence-audit")
        skill_candidate["statusSnapshot"]["evidencePath"] = "integrations/hosts/workbuddy/kiwi-merchant-buddy/review-assets/official/2026-10-13/buddy-app-pending-asset-id-snapshot.json"
        receipt_errors = validate(root, injected)
        probes.append(("negativeSevenSkillEvidenceInjection", any("status evidence must point to the seven-skill receipt ledger" in e for e in receipt_errors), skill_candidate["references"]["reviewAssetId"]))

        injected = copy.deepcopy(registry)
        cs = next(e for e in injected["entries"] if e.get("slug") == "kiwi-merchant-cs-prep")
        cs["statusSnapshot"]["value"] = "under_review"
        cs_errors = validate(root, injected)
        probes.append(("negativePublishedSnapshotMismatch", any("snapshot must bind ID/version/published" in e for e in cs_errors), "kiwi-merchant-cs-prep"))

        injected = copy.deepcopy(registry)
        cloud = next(e for e in injected["entries"] if e.get("slug") == "kiwi-cloud-deploy")
        cloud["references"]["marketReferenceId"] = None
        cloud["existingMarketReferenceSnapshot"]["evidencePath"] = "integrations/hosts/workbuddy/kiwi-merchant-buddy/review-assets/official/2026-10-13/does-not-exist.json"
        historical_errors = validate(root, injected)
        probes.append(("negativeNullCurrentIdHistoricalEvidenceMissing", any("earlier market reference evidence missing" in e for e in historical_errors), "kiwi-cloud-deploy"))

        split_record = '\n'.join([f'heading "{cs["name"]}"', f'StaticText "{cs["references"]["reviewAssetId"]}"', f'StaticText "v{cs["version"]}"', 'StaticText "已发布"'])
        split_rejected = not has_coherent_skill_status_record(split_record, cs["name"], cs["version"], cs["references"]["reviewAssetId"])
        probes.append(("negativeSplitCSRecord", split_rejected, "ID/version/status must be structurally bound"))

        for name, detected, expected in probes:
            result[name] = {"detected": detected, "expected": expected}
            if not detected:
                errors.append(f"{name} was not detected")

        # Prove the CLI outcome derives from the accumulated errors after all probes.
        simulated_errors = ["synthetic missed negative control"]
        simulated_status, simulated_exit = outcome(simulated_errors)
        result["negativeControlFailurePropagation"] = {"status": simulated_status, "exitCode": simulated_exit}
        if simulated_status != "FAIL" or simulated_exit != 1:
            errors.append("self-test error-to-exit propagation failed")
    result["errors"] = errors
    result["status"], exit_code = outcome(errors)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return exit_code

if __name__ == "__main__":
    raise SystemExit(main())
