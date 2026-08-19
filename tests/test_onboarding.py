"""Tests for agent-friendly Firefox profile onboarding."""

from __future__ import annotations

import hashlib
import json
from typing import TYPE_CHECKING
from unittest.mock import MagicMock, patch

import pytest

from ff_mcp.onboarding import (
    FirefoxProfile,
    addon_cache_directory,
    discover_firefox_profiles,
    download_signed_addon,
    find_firefox_binary,
    launch_addon_install,
    resolve_firefox_profile,
)

if TYPE_CHECKING:
    from pathlib import Path


def test_discovers_default_profile_and_installed_extension(tmp_path: Path) -> None:
    """Read defaults and installed extension state from Firefox profile files."""
    root = tmp_path / "firefox"
    profile_path = root / "Profiles/example.default-release"
    profile_path.mkdir(parents=True)
    (profile_path / "extensions.json").write_text(
        json.dumps({"addons": [{"id": "ff-mcp@local"}]}),
        encoding="utf-8",
    )
    (root / "profiles.ini").write_text(
        """[Profile0]
Name=default-release
IsRelative=1
Path=Profiles/example.default-release

[InstallABC]
Default=Profiles/example.default-release
Locked=1
""",
        encoding="utf-8",
    )

    profiles = discover_firefox_profiles((root,))

    assert len(profiles) == 1
    assert profiles[0].name == "default-release"
    assert profiles[0].path == profile_path.resolve()
    assert profiles[0].default is True
    assert profiles[0].as_dict()["ff_mcp_installed"] is True


def test_resolves_profile_by_name_or_unregistered_path(tmp_path: Path) -> None:
    """Accept a unique registered name and an explicit existing profile directory."""
    registered_path = tmp_path / "registered"
    unregistered_path = tmp_path / "manual-profile"
    registered_path.mkdir()
    unregistered_path.mkdir()
    registered = FirefoxProfile(
        name="Work",
        path=registered_path,
        default=False,
        source=tmp_path / "profiles.ini",
    )

    assert resolve_firefox_profile("work", (registered,)) == registered
    manual = resolve_firefox_profile(str(unregistered_path), (registered,))
    assert manual.name == "manual-profile"
    assert manual.path == unregistered_path.resolve()


def test_rejects_ambiguous_profile_name(tmp_path: Path) -> None:
    """Require a path when multiple Firefox installations reuse a profile name."""
    profiles = tuple(
        FirefoxProfile(
            name="default-release",
            path=tmp_path / suffix,
            default=False,
            source=tmp_path / suffix / "profiles.ini",
        )
        for suffix in ("standard", "snap")
    )

    with pytest.raises(ValueError, match="ambiguous"):
        resolve_firefox_profile("default-release", profiles)


def test_downloads_and_verifies_signed_addon(tmp_path: Path) -> None:
    """Write an XPI only when it matches the release's SHA-256 checksum."""
    xpi = b"signed xpi bytes"
    checksum = hashlib.sha256(xpi).hexdigest().encode()
    with patch("ff_mcp.onboarding._download", side_effect=[checksum + b"  addon.xpi\n", xpi]):
        path = download_signed_addon("1.2.3", tmp_path)

    assert path == tmp_path / "ff-mcp-v1.2.3-firefox-signed.xpi"
    assert path.read_bytes() == xpi


def test_rejects_signed_addon_checksum_mismatch(tmp_path: Path) -> None:
    """Reject a release asset that differs from the published checksum."""
    checksum = hashlib.sha256(b"expected").hexdigest().encode()
    with (
        patch("ff_mcp.onboarding._download", side_effect=[checksum, b"different"]),
        pytest.raises(ValueError, match="checksum mismatch"),
    ):
        download_signed_addon("1.2.3", tmp_path)


def test_finds_explicit_firefox_binary(tmp_path: Path) -> None:
    """Validate and return an explicit Firefox executable path."""
    binary = tmp_path / "firefox"
    binary.touch()
    assert find_firefox_binary(str(binary)) == binary.resolve()


def test_preserves_firefox_launcher_symlink(tmp_path: Path) -> None:
    """Keep an app-selecting launcher symlink instead of resolving its generic target."""
    generic_launcher = tmp_path / "snap"
    firefox_launcher = tmp_path / "firefox"
    generic_launcher.touch()
    firefox_launcher.symlink_to(generic_launcher)
    assert find_firefox_binary(str(firefox_launcher)) == firefox_launcher.absolute()


def test_uses_cache_visible_to_confined_firefox(tmp_path: Path) -> None:
    """Place release assets inside a selected Snap profile's visible app data."""
    home = tmp_path / "home"
    profile = FirefoxProfile(
        name="Snap",
        path=home / "snap/firefox/common/.mozilla/firefox/example",
        default=False,
        source=home / "snap/firefox/common/.mozilla/firefox/profiles.ini",
    )
    with patch("ff_mcp.onboarding.Path.home", return_value=home):
        assert addon_cache_directory(profile) == home / "snap/firefox/common/ff-mcp"


def test_launches_install_prompt_in_explicit_profile(tmp_path: Path) -> None:
    """Open a local XPI using the exact selected profile path."""
    profile_path = tmp_path / "profile"
    profile_path.mkdir()
    profile = FirefoxProfile(
        name="Work",
        path=profile_path,
        default=False,
        source=tmp_path / "profiles.ini",
    )
    firefox = tmp_path / "firefox"
    xpi = tmp_path / "addon.xpi"
    firefox.touch()
    xpi.write_bytes(b"xpi")

    with patch("ff_mcp.onboarding.subprocess.Popen") as popen:
        command = launch_addon_install(profile, xpi, firefox)

    assert command == (
        str(firefox),
        "-profile",
        str(profile_path),
        xpi.as_uri(),
    )
    popen.assert_called_once_with(
        command,
        stdin=-3,
        stdout=-3,
        stderr=-3,
        start_new_session=True,
    )


def test_profile_listing_tolerates_invalid_extensions_file(tmp_path: Path) -> None:
    """Treat incomplete Firefox state as not installed instead of failing discovery."""
    profile_path = tmp_path / "profile"
    profile_path.mkdir()
    (profile_path / "extensions.json").write_text("not-json", encoding="utf-8")
    profile = FirefoxProfile(
        name="Profile",
        path=profile_path,
        default=False,
        source=tmp_path / "profiles.ini",
    )
    assert profile.as_dict()["ff_mcp_installed"] is False


def test_launch_rejects_missing_xpi(tmp_path: Path) -> None:
    """Do not start Firefox when the selected XPI is missing."""
    profile = FirefoxProfile(
        name="Profile",
        path=tmp_path,
        default=False,
        source=tmp_path / "profiles.ini",
    )
    with pytest.raises(FileNotFoundError, match="Signed XPI does not exist"):
        launch_addon_install(profile, tmp_path / "missing.xpi", tmp_path / "firefox")


def test_cached_addon_avoids_duplicate_asset_download(tmp_path: Path) -> None:
    """Reuse a cached XPI after verifying it against the current checksum."""
    xpi = b"cached signed xpi"
    checksum = hashlib.sha256(xpi).hexdigest().encode()
    path = tmp_path / "ff-mcp-v1.2.3-firefox-signed.xpi"
    path.write_bytes(xpi)
    download = MagicMock(return_value=checksum)
    with patch("ff_mcp.onboarding._download", download):
        assert download_signed_addon("1.2.3", tmp_path) == path
    download.assert_called_once()


def test_rejects_unsafe_release_version(tmp_path: Path) -> None:
    """Do not use path or URL metacharacters from an invalid package version."""
    with pytest.raises(ValueError, match="Invalid release version"):
        download_signed_addon("../unexpected", tmp_path)
