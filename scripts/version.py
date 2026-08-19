"""Check or update every repository version source with one command."""

from __future__ import annotations

import argparse
import json
import re
import sys
import tomllib
from pathlib import Path

DEFAULT_ROOT = Path(__file__).resolve().parents[1]
VERSION_PATTERN = re.compile(r"(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)")
VERSION_PARTS = 3


def _read_init_version(root: Path) -> str:
    content = (root / "src/ff_mcp/__init__.py").read_text(encoding="utf-8")
    match = re.fullmatch(r'"""Firefox MCP native host\."""\n\n__version__ = "([^"]+)"\n', content)
    if match is None:
        msg = "Cannot find the package version in src/ff_mcp/__init__.py"
        raise ValueError(msg)
    return match.group(1)


def _read_versions(root: Path) -> dict[str, str]:
    pyproject = tomllib.loads((root / "pyproject.toml").read_text(encoding="utf-8"))
    manifest = json.loads((root / "extension/manifest.json").read_text(encoding="utf-8"))
    lock = tomllib.loads((root / "uv.lock").read_text(encoding="utf-8"))
    locked = [
        package["version"]
        for package in lock["package"]
        if package["name"] == "ff-mcp" and package.get("source") == {"editable": "."}
    ]
    if len(locked) != 1:
        msg = "uv.lock must contain exactly one editable ff-mcp package"
        raise ValueError(msg)
    return {
        "pyproject.toml": pyproject["project"]["version"],
        "src/ff_mcp/__init__.py": _read_init_version(root),
        "extension/manifest.json": manifest["version"],
        "uv.lock": locked[0],
    }


def _checked_version(value: str) -> str:
    if VERSION_PATTERN.fullmatch(value) is None:
        msg = f"Version must use numeric X.Y.Z form, got {value!r}"
        raise ValueError(msg)
    return value


def _current_version(root: Path) -> str:
    versions = _read_versions(root)
    distinct = set(versions.values())
    if len(distinct) != 1:
        details = ", ".join(f"{path}={version}" for path, version in versions.items())
        msg = f"Version sources do not match: {details}"
        raise ValueError(msg)
    return _checked_version(distinct.pop())


def _target_version(specifier: str, current: str) -> str:
    if specifier not in {"major", "minor", "patch"}:
        return _checked_version(specifier)
    parts = [int(part) for part in current.split(".")]
    if len(parts) != VERSION_PARTS:
        msg = f"Current version must have {VERSION_PARTS} parts"
        raise ValueError(msg)
    index = {"major": 0, "minor": 1, "patch": 2}[specifier]
    parts[index] += 1
    for reset_index in range(index + 1, VERSION_PARTS):
        parts[reset_index] = 0
    return ".".join(str(part) for part in parts)


def _replace_once(content: str, pattern: str, replacement: str, path: str) -> str:
    updated, count = re.subn(pattern, replacement, content, count=1)
    if count != 1:
        msg = f"Expected one version field in {path}, found {count}"
        raise ValueError(msg)
    return updated


def _bump_versions(root: Path, specifier: str) -> tuple[str, str]:
    current = _current_version(root)
    target = _target_version(specifier, current)
    escaped = re.escape(current)
    replacements = {
        "pyproject.toml": (rf'(?m)^(version = "){escaped}("$)', rf"\g<1>{target}\g<2>"),
        "src/ff_mcp/__init__.py": (
            rf'(?m)^(__version__ = "){escaped}("$)',
            rf"\g<1>{target}\g<2>",
        ),
        "extension/manifest.json": (
            rf'(?m)^(  "version": "){escaped}(",$)',
            rf"\g<1>{target}\g<2>",
        ),
        "uv.lock": (
            rf'(?m)^(name = "ff-mcp"\nversion = "){escaped}("$)',
            rf"\g<1>{target}\g<2>",
        ),
    }
    updated: dict[Path, str] = {}
    for relative, (pattern, replacement) in replacements.items():
        path = root / relative
        content = path.read_text(encoding="utf-8")
        updated[path] = _replace_once(content, pattern, replacement, relative)
    for path, content in updated.items():
        path.write_text(content, encoding="utf-8")
    if _current_version(root) != target:
        msg = "Version update verification failed"
        raise ValueError(msg)
    return current, target


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=DEFAULT_ROOT, help=argparse.SUPPRESS)
    commands = parser.add_subparsers(dest="command", required=True)
    check = commands.add_parser("check", help="fail unless all version sources match")
    check.add_argument("--expect", help="also require this exact version")
    bump = commands.add_parser("bump", help="update all version sources")
    bump.add_argument("version", help="X.Y.Z, major, minor, or patch")
    return parser


def _run(args: argparse.Namespace) -> str:
    if args.command == "check":
        current = _current_version(args.root)
        if args.expect is not None and current != _checked_version(args.expect):
            msg = f"Expected version {args.expect}, found {current}"
            raise ValueError(msg)
        return f"All version sources match: {current}"
    previous, current = _bump_versions(args.root, args.version)
    return f"Bumped all version sources: {previous} -> {current}"


def _main() -> int:
    args = _parser().parse_args()
    try:
        output = _run(args)
    except ValueError as error:
        sys.stderr.write(f"error: {error}\n")
        return 1
    sys.stdout.write(f"{output}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(_main())
