"""Discover Firefox profiles and prepare the signed add-on for local setup."""

from __future__ import annotations

import configparser
import hashlib
import json
import os
import shutil
import subprocess  # ruff: ignore[suspicious-subprocess-import] - fixed executable and arguments
import sys
from dataclasses import dataclass
from importlib.metadata import PackageNotFoundError
from importlib.metadata import version as distribution_version
from pathlib import Path
from typing import Any
from urllib.request import urlopen

from .installer import EXTENSION_ID

RELEASE_ORIGIN = "https://github.com/complynx/ff-mcp/releases/download"
DOWNLOAD_TIMEOUT_SECONDS = 30
SHA256_HEX_LENGTH = 64


@dataclass(frozen=True)
class FirefoxProfile:
    """A Firefox profile registered in a profiles.ini file."""

    name: str
    path: Path
    default: bool
    source: Path

    def as_dict(self) -> dict[str, str | bool]:
        """Return a JSON-serializable profile description.

        Returns:
            The profile name, path, default state, and ff-mcp installation state.

        """
        return {
            "name": self.name,
            "path": str(self.path),
            "default": self.default,
            "ff_mcp_installed": profile_has_extension(self),
        }


def firefox_profile_roots() -> tuple[Path, ...]:
    """Return likely Firefox profile roots for the current platform.

    Returns:
        Candidate directories containing Firefox profiles.ini files.

    """
    override = os.environ.get("FF_MCP_FIREFOX_PROFILE_ROOTS")
    if override:
        return tuple(Path(value).expanduser() for value in override.split(os.pathsep) if value)

    if sys.platform == "darwin":
        candidates = (Path.home() / "Library/Application Support/Firefox",)
    elif os.name == "nt":
        app_data = Path(os.environ.get("APPDATA", Path.home()))
        candidates = (app_data / "Mozilla/Firefox",)
    else:
        candidates = (
            Path.home() / ".mozilla/firefox",
            Path.home() / "snap/firefox/common/.mozilla/firefox",
            Path.home() / ".var/app/org.mozilla.firefox/.mozilla/firefox",
        )
    return tuple(dict.fromkeys(candidates))


def _read_ini(path: Path) -> configparser.ConfigParser | None:
    if not path.is_file():
        return None
    parser = configparser.ConfigParser(interpolation=None)
    try:
        with path.open(encoding="utf-8") as stream:
            parser.read_file(stream)
    except configparser.Error, OSError, UnicodeError:
        return None
    return parser


def _default_profile_paths(root: Path, *parsers: configparser.ConfigParser | None) -> set[Path]:
    defaults: set[Path] = set()
    for parser in parsers:
        if parser is None:
            continue
        for section in parser.sections():
            if not section.casefold().startswith("install"):
                continue
            value = parser.get(section, "Default", fallback="").strip()
            if value:
                defaults.add((root / value).resolve())
    return defaults


def discover_firefox_profiles(roots: tuple[Path, ...] | None = None) -> tuple[FirefoxProfile, ...]:
    """Discover registered profiles in standard, Snap, and Flatpak locations.

    Returns:
        Existing registered Firefox profiles, with defaults first.

    """
    profiles_by_path: dict[Path, FirefoxProfile] = {}
    for root in roots if roots is not None else firefox_profile_roots():
        profiles_ini = root / "profiles.ini"
        profiles_parser = _read_ini(profiles_ini)
        if profiles_parser is None:
            continue
        default_paths = _default_profile_paths(
            root,
            profiles_parser,
            _read_ini(root / "installs.ini"),
        )
        for section in profiles_parser.sections():
            if not section.casefold().startswith("profile"):
                continue
            raw_path = profiles_parser.get(section, "Path", fallback="").strip()
            if not raw_path:
                continue
            relative = profiles_parser.get(section, "IsRelative", fallback="1") == "1"
            profile_path = Path(raw_path).expanduser()
            if relative:
                profile_path = root / profile_path
            profile_path = profile_path.resolve()
            if not profile_path.is_dir():
                continue
            declared_default = profiles_parser.get(section, "Default", fallback="0") == "1"
            profile = FirefoxProfile(
                name=profiles_parser.get(section, "Name", fallback=section),
                path=profile_path,
                default=declared_default or profile_path in default_paths,
                source=profiles_ini,
            )
            profiles_by_path[profile_path] = profile
    return tuple(
        sorted(
            profiles_by_path.values(),
            key=lambda profile: (not profile.default, profile.name.casefold(), str(profile.path)),
        )
    )


def resolve_firefox_profile(
    selector: str, profiles: tuple[FirefoxProfile, ...] | None = None
) -> FirefoxProfile:
    """Resolve an explicit profile name or directory.

    Returns:
        The uniquely selected registered or explicit Firefox profile.

    Raises:
        FileNotFoundError: If an explicit profile directory does not exist.
        ValueError: If a name is missing or ambiguous.

    """
    available = profiles if profiles is not None else discover_firefox_profiles()
    looks_like_path = Path(selector).is_absolute() or any(
        separator and separator in selector for separator in (os.sep, os.altsep)
    )
    if looks_like_path:
        path = Path(selector).expanduser().resolve()
        if not path.is_dir():
            error = f"Firefox profile directory does not exist: {path}"
            raise FileNotFoundError(error)
        for profile in available:
            if profile.path == path:
                return profile
        return FirefoxProfile(name=path.name, path=path, default=False, source=path)

    matches = [profile for profile in available if profile.name.casefold() == selector.casefold()]
    if len(matches) == 1:
        return matches[0]
    if len(matches) > 1:
        paths = ", ".join(str(profile.path) for profile in matches)
        error = f"Firefox profile name {selector!r} is ambiguous; select a path: {paths}"
        raise ValueError(error)
    names = ", ".join(profile.name for profile in available) or "none found"
    error = f"Unknown Firefox profile {selector!r}; available profiles: {names}"
    raise ValueError(error)


def profile_has_extension(profile: FirefoxProfile) -> bool:
    """Return whether Firefox records ff-mcp as installed in a profile.

    Returns:
        Whether the profile's extension registry contains the ff-mcp add-on ID.

    """
    extensions_path = profile.path / "extensions.json"
    try:
        payload: Any = json.loads(extensions_path.read_text(encoding="utf-8"))
    except FileNotFoundError, json.JSONDecodeError, OSError, UnicodeError:
        return False
    if not isinstance(payload, dict):
        return False
    addons = payload.get("addons")
    return isinstance(addons, list) and any(
        isinstance(addon, dict) and addon.get("id") == EXTENSION_ID for addon in addons
    )


def find_firefox_binary(explicit: str | None = None) -> Path | None:
    """Find an installed Firefox executable, optionally validating an override.

    Returns:
        The Firefox executable, or ``None`` if automatic discovery fails.

    Raises:
        FileNotFoundError: If an explicit executable does not exist.

    """
    if explicit:
        found = shutil.which(explicit)
        candidate = Path(found) if found else Path(explicit).expanduser()
        candidate = candidate.absolute()
        if not candidate.is_file():
            error = f"Firefox executable does not exist: {candidate}"
            raise FileNotFoundError(error)
        return candidate

    found = shutil.which("firefox")
    if found:
        return Path(found).absolute()

    if sys.platform == "darwin":
        candidates = (Path("/Applications/Firefox.app/Contents/MacOS/firefox"),)
    elif os.name == "nt":
        candidates = tuple(
            Path(base) / "Mozilla Firefox/firefox.exe"
            for variable in ("PROGRAMFILES", "PROGRAMFILES(X86)")
            if (base := os.environ.get(variable))
        )
    else:
        candidates = (Path("/snap/bin/firefox"), Path("/usr/bin/firefox"))
    return next((candidate for candidate in candidates if candidate.is_file()), None)


def installed_version() -> str:
    """Return the ff-mcp package version used to select a signed release.

    Returns:
        The installed distribution or checkout extension version.

    """
    try:
        return distribution_version("ff-mcp")
    except PackageNotFoundError:
        return _checkout_version()


def _checkout_version() -> str:
    manifest_path = Path(__file__).resolve().parents[2] / "extension/manifest.json"
    try:
        payload: Any = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, OSError, UnicodeError) as error:
        message = "Unable to determine the ff-mcp version"
        raise RuntimeError(message) from error
    if not isinstance(payload, dict) or not isinstance(payload.get("version"), str):
        message = "Extension manifest does not contain a version"
        raise TypeError(message)
    return payload["version"]


def addon_cache_directory(profile: FirefoxProfile | None = None) -> Path:
    """Return an XPI cache visible to the selected Firefox package.

    Returns:
        A host cache directory, or a confined app directory for Snap and Flatpak profiles.

    """
    if profile is not None:
        snap_root = Path.home() / "snap/firefox/common"
        flatpak_root = Path.home() / ".var/app/org.mozilla.firefox"
        if profile.path.is_relative_to(snap_root):
            return snap_root / "ff-mcp"
        if profile.path.is_relative_to(flatpak_root):
            return flatpak_root / "cache/ff-mcp"
    if sys.platform == "darwin":
        return Path.home() / "Library/Caches/ff-mcp"
    if os.name == "nt":
        base = Path(os.environ.get("LOCALAPPDATA", os.environ.get("APPDATA", Path.home())))
        return base / "ff-mcp/Cache"
    return Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache")) / "ff-mcp"


def _download(url: str) -> bytes:
    # URLs are built from the fixed HTTPS release origin above.
    with urlopen(  # ruff: ignore[suspicious-url-open-usage]
        url, timeout=DOWNLOAD_TIMEOUT_SECONDS
    ) as response:
        return response.read()


def _parse_checksum(payload: bytes) -> str:
    try:
        checksum = payload.decode("utf-8").split()[0].casefold()
    except (IndexError, UnicodeDecodeError) as error:
        message = "Release checksum response is invalid"
        raise ValueError(message) from error
    if len(checksum) != SHA256_HEX_LENGTH or any(
        character not in "0123456789abcdef" for character in checksum
    ):
        message = "Release checksum is not a SHA-256 digest"
        raise ValueError(message)
    return checksum


def download_signed_addon(
    release_version: str | None = None,
    destination: Path | None = None,
) -> Path:
    """Download and verify the signed XPI for the installed ff-mcp version.

    Returns:
        The verified local XPI path.

    Raises:
        ValueError: If the published checksum is invalid or does not match.

    """
    selected_version = release_version or installed_version()
    if not selected_version or any(
        not character.isascii() or not (character.isalnum() or character in ".-+")
        for character in selected_version
    ):
        error = f"Invalid release version: {selected_version!r}"
        raise ValueError(error)
    filename = f"ff-mcp-v{selected_version}-firefox-signed.xpi"
    directory = destination or addon_cache_directory()
    directory.mkdir(parents=True, exist_ok=True)
    xpi_path = directory / filename
    release_url = f"{RELEASE_ORIGIN}/v{selected_version}/{filename}"
    checksum = _parse_checksum(_download(f"{release_url}.sha256"))
    if xpi_path.is_file() and hashlib.sha256(xpi_path.read_bytes()).hexdigest() == checksum:
        return xpi_path

    xpi = _download(release_url)
    actual = hashlib.sha256(xpi).hexdigest()
    if actual != checksum:
        error = f"Signed XPI checksum mismatch: expected {checksum}, received {actual}"
        raise ValueError(error)
    xpi_path.write_bytes(xpi)
    return xpi_path


def launch_addon_install(
    profile: FirefoxProfile,
    xpi_path: Path,
    firefox_binary: Path,
) -> tuple[str, ...]:
    """Open a signed XPI in an explicit Firefox profile for user confirmation.

    Returns:
        The command launched for diagnostic output.

    Raises:
        FileNotFoundError: If the selected XPI does not exist.

    """
    resolved_xpi = xpi_path.expanduser().resolve()
    if not resolved_xpi.is_file():
        error = f"Signed XPI does not exist: {resolved_xpi}"
        raise FileNotFoundError(error)
    command = (
        str(firefox_binary),
        "-profile",
        str(profile.path),
        resolved_xpi.as_uri(),
    )
    # The executable is resolved and every argument is passed without a shell.
    if os.name == "nt":
        creation_flags = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
        subprocess.Popen(  # ruff: ignore[subprocess-without-shell-equals-true]
            command,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=creation_flags,
        )
    else:
        subprocess.Popen(  # ruff: ignore[subprocess-without-shell-equals-true]
            command,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
    return command
