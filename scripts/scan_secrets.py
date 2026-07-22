#!/usr/bin/env python3
from __future__ import annotations

import argparse
from collections import Counter
from dataclasses import dataclass
import math
from pathlib import Path
import re
import subprocess
import sys
from typing import Iterable


MAX_BLOB_BYTES = 5 * 1024 * 1024
MAX_FINDINGS = 100
ALLOW_TEST_FIXTURE_MARKER = "secret-scan: allow-test-fixture"

HIGH_CONFIDENCE_RULES = (
    (
        "private-key",
        re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
    ),
    ("aws-access-key", re.compile(r"AKIA[0-9A-Z]{16}")),
    ("google-api-key", re.compile(r"AIza[0-9A-Za-z_-]{35}")),
    ("github-token", re.compile(r"gh[pousr]_[0-9A-Za-z]{36,255}")),
    ("github-pat", re.compile(r"github_pat_[0-9A-Za-z_]{70,255}")),
    ("slack-token", re.compile(r"xox[baprs]-[0-9A-Za-z-]{20,}")),
    ("stripe-live-key", re.compile(r"(?:sk|rk)_live_[0-9A-Za-z]{20,}")),
    (
        "argon2id-hash",
        re.compile(r"\$argon2id\$v=\d+\$m=\d+,t=\d+,p=\d+\$[A-Za-z0-9+/=]{8,}\$[A-Za-z0-9+/=]{8,}"),
    ),
)

SECRET_ASSIGNMENT = re.compile(
    r"(?i)\b(?P<name>[A-Za-z][A-Za-z0-9_.-]{0,80}"
    r"(?:api[_-]?key|client[_-]?secret|app[_-]?secret(?:[_-]?key)?|"
    r"secret[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|credential)"
    r"[A-Za-z0-9_.-]{0,80})\b\s*(?::|=)\s*[\"']?"
    r"(?P<value>[A-Za-z0-9+/_=.-]{20,})"
)

PLACEHOLDER_MARKERS = (
    "changeme",
    "development",
    "dummy",
    "example",
    "fake",
    "placeholder",
    "replacewith",
    "sample",
    "testonly",
    "yourkey",
    "yoursecret",
)


@dataclass(frozen=True)
class Finding:
    source: str
    path: str
    line: int
    rule: str
    object_id: str | None = None


def _entropy(value: str) -> float:
    counts = Counter(value)
    length = len(value)
    return -sum((count / length) * math.log2(count / length) for count in counts.values())


def _looks_like_placeholder(name: str, value: str) -> bool:
    lower_value = value.casefold()
    normalized = re.sub(r"[^a-z0-9]", "", lower_value)
    if any(marker in normalized for marker in PLACEHOLDER_MARKERS):
        return True
    if lower_value.startswith(("ci_", "ci-", "mock_", "mock-", "test_", "test-")):
        return True
    if name.casefold().endswith(("_file", "-file", "_path", "-path")):
        return True
    return value.startswith(("/", "./", "../"))


def scan_text(
    text: str,
    *,
    source: str,
    path: str,
    object_id: str | None = None,
) -> list[Finding]:
    findings: list[Finding] = []
    for line_number, line in enumerate(text.splitlines(), start=1):
        if ALLOW_TEST_FIXTURE_MARKER in line:
            continue
        matched_rules: set[str] = set()
        for rule, pattern in HIGH_CONFIDENCE_RULES:
            if pattern.search(line):
                matched_rules.add(rule)

        for match in SECRET_ASSIGNMENT.finditer(line):
            name = match.group("name")
            value = match.group("value")
            if not _looks_like_placeholder(name, value) and _entropy(value) >= 3.5:
                matched_rules.add("high-entropy-secret-assignment")

        findings.extend(
            Finding(
                source=source,
                path=path,
                line=line_number,
                rule=rule,
                object_id=object_id,
            )
            for rule in sorted(matched_rules)
        )
    return findings


def _run_git(repo: Path, arguments: list[str], *, input_text: str | None = None) -> str:
    completed = subprocess.run(
        ["git", "-C", str(repo), *arguments],
        input=input_text,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        check=False,
    )
    if completed.returncode != 0:
        detail = completed.stderr.strip().splitlines()
        message = detail[-1] if detail else "git command failed"
        raise RuntimeError(message)
    return completed.stdout


def _is_scannable(data: bytes) -> bool:
    return len(data) <= MAX_BLOB_BYTES and b"\0" not in data[:8192]


def scan_worktree(repo: Path) -> list[Finding]:
    tracked = _run_git(repo, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"])
    findings: list[Finding] = []
    for relative_path in tracked.split("\0"):
        if not relative_path:
            continue
        candidate = repo / relative_path
        try:
            data = candidate.read_bytes()
        except (FileNotFoundError, IsADirectoryError, OSError):
            continue
        if not _is_scannable(data):
            continue
        findings.extend(
            scan_text(
                data.decode("utf-8", errors="ignore"),
                source="worktree",
                path=relative_path,
            )
        )
    return findings


def _history_objects(repo: Path) -> list[tuple[str, str, int]]:
    listing = _run_git(repo, ["-c", "core.quotePath=false", "rev-list", "--objects", "--all"])
    paths_by_object: dict[str, str] = {}
    for line in listing.splitlines():
        object_id, separator, path = line.partition(" ")
        if separator and path and object_id not in paths_by_object:
            paths_by_object[object_id] = path
    if not paths_by_object:
        return []

    object_ids = list(paths_by_object)
    metadata = _run_git(
        repo,
        ["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"],
        input_text="\n".join(object_ids) + "\n",
    )
    blobs: list[tuple[str, str, int]] = []
    for line in metadata.splitlines():
        fields = line.split()
        if len(fields) != 3 or fields[1] != "blob":
            continue
        size = int(fields[2])
        if size <= MAX_BLOB_BYTES:
            blobs.append((fields[0], paths_by_object[fields[0]], size))
    return blobs


def _read_history_blobs(
    repo: Path,
    objects: Iterable[tuple[str, str, int]],
) -> Iterable[tuple[str, str, bytes]]:
    process = subprocess.Popen(
        ["git", "-C", str(repo), "cat-file", "--batch"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    if process.stdin is None or process.stdout is None:
        process.kill()
        raise RuntimeError("could not open git object stream")
    try:
        for object_id, path, expected_size in objects:
            process.stdin.write(f"{object_id}\n".encode("ascii"))
            process.stdin.flush()
            header = process.stdout.readline().decode("ascii", errors="replace").strip()
            fields = header.split()
            if len(fields) != 3 or fields[1] != "blob":
                raise RuntimeError("git returned an invalid object header")
            actual_size = int(fields[2])
            if actual_size != expected_size:
                raise RuntimeError("git object size changed during secret scan")
            data = process.stdout.read(actual_size)
            if len(data) != actual_size or process.stdout.read(1) != b"\n":
                raise RuntimeError("git returned a truncated object")
            yield object_id, path, data
    finally:
        process.stdin.close()
        process.wait(timeout=10)
        if process.returncode != 0:
            raise RuntimeError("git object reader failed")


def scan_history(repo: Path) -> list[Finding]:
    findings: list[Finding] = []
    for object_id, path, data in _read_history_blobs(repo, _history_objects(repo)):
        if not _is_scannable(data):
            continue
        findings.extend(
            scan_text(
                data.decode("utf-8", errors="ignore"),
                source="history",
                path=path,
                object_id=object_id,
            )
        )
        if len(findings) >= MAX_FINDINGS:
            break
    return findings


def _parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Scan tracked Git content for likely secrets")
    parser.add_argument("--repo", type=Path, default=Path.cwd())
    parser.add_argument("--history", action="store_true", help="also scan every reachable Git blob")
    return parser.parse_args()


def main() -> int:
    arguments = _parse_arguments()
    repo = arguments.repo.resolve()
    try:
        _run_git(repo, ["rev-parse", "--git-dir"])
        findings = scan_worktree(repo)
        if arguments.history:
            findings.extend(scan_history(repo))
    except (OSError, RuntimeError, subprocess.SubprocessError) as error:
        print(f"Secret scan could not complete: {error}", file=sys.stderr)
        return 2

    unique_findings = list(dict.fromkeys(findings))[:MAX_FINDINGS]
    if not unique_findings:
        print("Secret scan passed: no likely secret material detected.")
        return 0

    print(
        f"Secret scan detected {len(unique_findings)} potential secret occurrence(s):",
        file=sys.stderr,
    )
    for finding in unique_findings:
        object_label = f" blob={finding.object_id[:12]}" if finding.object_id else ""
        print(
            f"  {finding.source}:{finding.path}:{finding.line} rule={finding.rule}{object_label}",
            file=sys.stderr,
        )
    print("Matched values are intentionally redacted.", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
