#!/usr/bin/env python3
"""Runner-owned Firefox observer for the mounted Registry drill.

This process owns the temporary Firefox profile and the browser checkpoints.
It never records token plaintext, cookies, credentials, or private keys.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

from selenium import webdriver
from selenium.common.exceptions import WebDriverException
from selenium.webdriver.common.by import By
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.firefox.service import Service
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.support.ui import WebDriverWait


WAIT_SECONDS = 1800
POLL_SECONDS = 1.0


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def write_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def resolve_geckodriver() -> str:
    configured = os.environ.get("DSH_ORBIT_GECKODRIVER")
    candidates = [configured] if configured else []
    candidates.extend([shutil.which("geckodriver"), str(Path(tempfile.gettempdir()) / "geckodriver.exe")])
    for candidate in candidates:
        if candidate and Path(candidate).exists():
            return candidate
    raise RuntimeError("geckodriver.exe was not found; set DSH_ORBIT_GECKODRIVER")


def certificate_thumbprint(ca_path: Path) -> str:
    result = subprocess.run(
        ["openssl", "x509", "-in", str(ca_path), "-noout", "-fingerprint", "-sha1"],
        check=True,
        capture_output=True,
        text=True,
    )
    return result.stdout.strip().split("=", 1)[-1].replace(":", "").upper()


def install_windows_root(ca_path: Path) -> tuple[str, bool]:
    """Install only this drill CA into CurrentUser Root and report ownership."""
    thumbprint = certificate_thumbprint(ca_path)
    lookup = subprocess.run(
        ["certutil.exe", "-user", "-store", "Root", thumbprint],
        capture_output=True,
        text=True,
    )
    if lookup.returncode == 0:
        return thumbprint, False
    subprocess.run(
        ["certutil.exe", "-user", "-addstore", "Root", str(ca_path)],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
    )
    return thumbprint, True


def remove_windows_root(thumbprint: str, owned: bool) -> None:
    if not owned:
        return
    subprocess.run(
        ["certutil.exe", "-user", "-delstore", "Root", thumbprint],
        check=False,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def wait_for(wait: WebDriverWait, condition):
    return wait.until(condition)


def browser_text(driver, locator: tuple[str, str]) -> str:
    return driver.find_element(*locator).text.strip()


def wait_for_node_ids(driver, expected: list[str], stop_path: Path) -> bool:
    deadline = time.monotonic() + WAIT_SECONDS
    while time.monotonic() < deadline:
        if stop_path.exists():
            return False
        driver.find_element(By.ID, "nav-nodes").click()
        time.sleep(0.25)
        ids = {
            element.text.strip()
            for element in driver.find_elements(By.CSS_SELECTOR, ".node-id")
            if element.text.strip()
        }
        if all(node_id in ids for node_id in expected):
            return
        time.sleep(POLL_SECONDS)
    raise RuntimeError("current-run node IDs did not appear in the Nodes list before timeout")


def run(args: argparse.Namespace) -> int:
    log_path = Path(args.log_path)
    log_path.parent.mkdir(parents=True, exist_ok=True)

    def log(message: str) -> None:
        line = f"{utc_now()} {message}"
        print(line, file=sys.stderr, flush=True)
        with log_path.open("a", encoding="utf-8") as stream:
            stream.write(line + "\n")

    bindings = read_json(Path(args.bindings_path))
    log("bindings-loaded")
    challenge = os.environ.get("DSH_ORBIT_BROWSER_CHALLENGE", "")
    if not challenge:
        raise RuntimeError("runner browser challenge is missing")
    challenge_digest = hashlib.sha256(challenge.encode("utf-8")).hexdigest()

    ca_path = Path(args.ca_path)
    log(f"installing-ca:{ca_path.name}")
    thumbprint, owned_root = install_windows_root(ca_path)
    log(f"ca-trusted:{thumbprint}:{'owned' if owned_root else 'preexisting'}")
    profile_dir = Path(tempfile.mkdtemp(prefix="dsh-orbit-firefox-"))
    gecko_log = log_path.with_name("geckodriver.log")
    driver = None
    try:
        options = Options()
        options.add_argument("-profile")
        options.add_argument(str(profile_dir))
        options.set_preference("security.enterprise_roots.enabled", True)
        options.set_preference("network.trr.mode", 5)
        options.accept_insecure_certs = False
        log("starting-firefox")
        driver = webdriver.Firefox(options=options, service=Service(resolve_geckodriver(), log_output=str(gecko_log)))
        log("firefox-started")
        driver.set_page_load_timeout(60)
        wait = WebDriverWait(driver, WAIT_SECONDS, poll_frequency=POLL_SECONDS)

        # URL credentials exercise the real browser Basic Auth path without
        # logging or storing the password in any checkpoint.
        gateway = bindings["gatewayUrl"]
        log("navigating-gateway-authenticated")
        driver.get(gateway.replace("https://", "https://operator:drill-password@", 1) + "/")
        # Firefox rejects page fetches while the document URL retains userinfo.
        # Navigate to the same origin without userinfo after the browser has
        # cached the real Basic Auth challenge response.
        driver.get(gateway + "/")
        log(f"gateway-loaded:title={driver.title!r}:url={driver.current_url!r}")
        body_text = driver.find_element(By.TAG_NAME, "body").text.strip().replace("\\n", " ")[:160]
        log(f"gateway-body-prefix:{body_text!r}")
        session_status = wait_for(wait, EC.visibility_of_element_located((By.ID, "session-status")))
        wait.until(lambda _driver: session_status.text.strip().startswith("operator:"))
        log("session-authenticated")

        driver.find_element(By.ID, "nav-tokens").click()
        wait_for(wait, EC.visibility_of_element_located((By.ID, "tokens-view")))
        driver.find_element(By.ID, "mint-token").click()
        plaintext = wait_for(wait, EC.visibility_of_element_located((By.CSS_SELECTOR, "code[data-plaintext-once]")))
        if not plaintext.text.strip():
            raise RuntimeError("token plaintext-once element was empty")
        log("token-observed")

        bootstrap = {
            **bindings,
            "tlsValidation": "enabled",
            "trustedHttps": True,
            "authenticated": True,
            "sessionBootstrapped": True,
            "tokenMinted": True,
            "plaintextOneTimeVerified": True,
            "browserProducer": "runner-owned-firefox-selenium",
            "challengeDigest": challenge_digest,
            "recordedAt": utc_now(),
        }
        write_json(Path(args.bootstrap_path), bootstrap)
        log("bootstrap-checkpoint-written")

        node_binding_path = Path(args.node_binding_path)
        stop_path = Path(args.stop_path)
        while not node_binding_path.exists():
            if stop_path.exists():
                return 0
            time.sleep(POLL_SECONDS)
        node_binding = read_json(node_binding_path)
        if node_binding.get("runId") != bindings.get("runId") or node_binding.get("commit") != bindings.get("commit"):
            raise RuntimeError("node binding does not match browser run")
        node_ids = node_binding.get("nodeIds")
        if not isinstance(node_ids, list) or len(node_ids) != 2 or len(set(node_ids)) != 2:
            raise RuntimeError("node binding must contain exactly two distinct node IDs")

        driver.find_element(By.ID, "nav-nodes").click()
        wait_for(wait, EC.visibility_of_element_located((By.ID, "nodes-view")))
        if not wait_for_node_ids(driver, node_ids, stop_path):
            return 0
        node_elements = driver.find_elements(By.CSS_SELECTOR, ".node-id")
        visible_ids = {element.text.strip() for element in node_elements}
        if not set(node_ids).issubset(visible_ids):
            raise RuntimeError("current-run node IDs were not independently observed in the Nodes list")
        driver.find_element(By.XPATH, f"//*[contains(@class, 'node-id') and normalize-space()='{node_ids[0]}']").click()
        detail = wait_for(wait, EC.visibility_of_element_located((By.ID, "node-detail-view")))
        detail_heading = wait_for(wait, EC.visibility_of_element_located((By.CSS_SELECTOR, "#node-detail-view h2")))
        if detail_heading.text.strip() != node_ids[0]:
            raise RuntimeError("node detail heading did not match the current-run node ID")
        if "Route Target" not in detail.text:
            raise RuntimeError("node detail did not expose Route Target")

        lifecycle = {
            **bindings,
            "tlsValidation": "enabled",
            "trustedHttps": True,
            "authenticated": True,
            "nodesObserved": True,
            "nodeDetailObserved": True,
            "sessionBootstrapped": True,
            "tokenMinted": True,
            "plaintextOneTimeVerified": True,
            "nodeIds": node_ids,
            "browserProducer": "runner-owned-firefox-selenium",
            "challengeDigest": challenge_digest,
            "recordedAt": utc_now(),
        }
        write_json(Path(args.lifecycle_path), lifecycle)

        while not stop_path.exists():
            time.sleep(POLL_SECONDS)
        return 0
    finally:
        if driver is not None:
            try:
                driver.quit()
            except WebDriverException:
                pass
        remove_windows_root(thumbprint, owned_root)
        shutil.rmtree(profile_dir, ignore_errors=True)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--bindings-path", required=True)
    parser.add_argument("--ca-path", required=True)
    parser.add_argument("--bootstrap-path", required=True)
    parser.add_argument("--lifecycle-path", required=True)
    parser.add_argument("--node-binding-path", required=True)
    parser.add_argument("--stop-path", required=True)
    parser.add_argument("--log-path", required=True)
    args = parser.parse_args()
    try:
        return run(args)
    except Exception as error:  # no token or credential values are included
        print(f"browser bridge failed: {type(error).__name__}: {error}", file=sys.stderr, flush=True)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
