"""Opt-in smoke test for the extension in an installed Firefox."""

import json
import os
from pathlib import Path
from tempfile import TemporaryDirectory
from zipfile import ZIP_DEFLATED, ZipFile

import pytest
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.firefox.service import Service
from selenium.webdriver.support.ui import WebDriverWait

RUN_FIREFOX_TESTS = os.environ.get("FF_MCP_RUN_FIREFOX_TESTS") == "1"
PROJECT_ROOT = Path(__file__).resolve().parents[1]
EXTENSION_ROOT = PROJECT_ROOT / "extension"
SNAP_FIREFOX_BINARY = Path("/snap/firefox/current/usr/lib/firefox/firefox")
TEST_EXTENSION_UUID = "3d53a887-5704-40ef-a174-53ad7565c26b"

pytestmark = pytest.mark.skipif(
    not RUN_FIREFOX_TESTS,
    reason="set FF_MCP_RUN_FIREFOX_TESTS=1 to launch installed Firefox",
)


def _build_xpi(destination: Path) -> None:
    """Package the extension into an XPI accepted by WebDriver."""
    with ZipFile(destination, "w", ZIP_DEFLATED) as archive:
        for source in sorted(EXTENSION_ROOT.rglob("*")):
            if source.is_file():
                archive.write(source, source.relative_to(EXTENSION_ROOT))


def test_extension_starts_in_fresh_firefox_profile() -> None:
    """Load the real extension temporarily and confirm Firefox registers it."""
    with TemporaryDirectory(prefix=".ff-mcp-firefox-", dir=PROJECT_ROOT) as temporary:
        test_root = Path(temporary)
        xpi = test_root / "ff-mcp.xpi"
        profile_root = test_root / "profiles"
        profile_root.mkdir()
        _build_xpi(xpi)

        options = Options()
        options.add_argument("-headless")
        options.set_preference(
            "extensions.webextensions.uuids",
            json.dumps({"ff-mcp@local": TEST_EXTENSION_UUID}),
        )
        configured_binary = os.environ.get("FIREFOX_BINARY")
        if configured_binary:
            options.binary_location = configured_binary
            service = Service(service_args=["--allow-system-access"])
        elif SNAP_FIREFOX_BINARY.is_file():
            options.binary_location = str(SNAP_FIREFOX_BINARY)
            service = Service(
                executable_path="/snap/bin/geckodriver",
                service_args=[
                    "--allow-system-access",
                    "--profile-root",
                    str(profile_root),
                ],
            )
        else:
            service = Service(service_args=["--allow-system-access"])

        driver = webdriver.Firefox(options=options, service=service)
        try:
            addon_id = driver.install_addon(str(xpi), temporary=True)
            assert addon_id == "ff-mcp@local"

            driver.set_context(driver.CONTEXT_CHROME)
            driver.execute_script(
                """
                window.gBrowser.selectedBrowser.loadURI(Services.io.newURI(arguments[0]), {
                  triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
                });
                """,
                f"moz-extension://{TEST_EXTENSION_UUID}/options.html",
            )
            driver.set_context(driver.CONTEXT_CONTENT)
            WebDriverWait(driver, 15).until(
                lambda current: (
                    "Localhost read access" in current.find_element(By.TAG_NAME, "body").text
                ),
            )
            body = driver.find_element(By.TAG_NAME, "body")
            assert "Localhost read access" in body.text
            assert "Main container · AND" in body.text
            assert "NOT AND" in body.text

            test_url = driver.find_element(By.ID, "test-url")
            test_url.clear()
            test_url.send_keys("http://localhost:3000/")
            driver.find_element(By.ID, "test").click()
            WebDriverWait(driver, 15).until(
                lambda current: current.find_element(By.ID, "test-result").text == "Matches",
            )
        finally:
            driver.quit()
