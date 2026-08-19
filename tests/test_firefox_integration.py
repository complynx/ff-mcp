"""Opt-in smoke test for the extension in an installed Firefox."""

from __future__ import annotations

import json
import os
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import TYPE_CHECKING
from zipfile import ZIP_DEFLATED, ZipFile

import pytest
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.firefox.service import Service
from selenium.webdriver.support.ui import WebDriverWait

if TYPE_CHECKING:
    from selenium.webdriver.remote.webelement import WebElement

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


def _toggle_closed_and_open(driver: webdriver.Firefox, details: WebElement) -> None:
    """Verify that a native disclosure can close and reopen."""
    assert details.get_dom_attribute("open") is not None
    summary = details.find_element(By.CSS_SELECTOR, ":scope > summary")
    summary.click()
    WebDriverWait(driver, 15).until(
        lambda _current: details.get_dom_attribute("open") is None,
    )
    summary.click()
    WebDriverWait(driver, 15).until(
        lambda _current: details.get_dom_attribute("open") is not None,
    )


def _edit_default_rule(driver: webdriver.Firefox) -> None:
    """Verify that the required localhost rule and its containers are editable."""
    default_rule = driver.find_element(By.CSS_SELECTOR, "details.rule-card.default-rule")
    rule_name = default_rule.find_element(By.CSS_SELECTOR, "input.rule-name")
    assert rule_name.is_enabled()
    assert rule_name.get_dom_attribute("readonly") is None
    enabled = default_rule.find_element(
        By.CSS_SELECTOR,
        ".rule-card-header .inline-check input",
    )
    assert enabled.is_enabled()
    _toggle_closed_and_open(driver, default_rule)

    nested_group = default_rule.find_element(
        By.CSS_SELECTOR,
        "details.rule-group details.rule-group",
    )
    _toggle_closed_and_open(driver, nested_group)

    first_condition = default_rule.find_element(
        By.CSS_SELECTOR,
        "input[aria-label='Condition value']",
    )
    assert first_condition.is_enabled()
    assert first_condition.get_dom_attribute("readonly") is None
    first_condition.clear()
    first_condition.send_keys("editable.example")
    driver.find_element(By.ID, "save").click()
    WebDriverWait(driver, 15).until(
        lambda current: current.find_element(By.ID, "save-result").text == "Saved",
    )


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

            _edit_default_rule(driver)

            test_url = driver.find_element(By.ID, "test-url")
            test_url.clear()
            test_url.send_keys("https://editable.example/")
            driver.find_element(By.ID, "test").click()
            WebDriverWait(driver, 15).until(
                lambda current: current.find_element(By.ID, "test-result").text == "Matches",
            )
        finally:
            driver.quit()
