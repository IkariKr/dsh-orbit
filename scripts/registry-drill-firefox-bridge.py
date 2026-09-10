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
import select
import shutil
import socket
import socketserver
import subprocess
import sys
import tempfile
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

from selenium import webdriver
from selenium.common.exceptions import WebDriverException
from selenium.webdriver.common.by import By
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.firefox.service import Service
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.support.ui import WebDriverWait


WAIT_SECONDS = 1800
POLL_SECONDS = 1.0
CERTUTIL_TIMEOUT_SECONDS = 20
WEBDRIVER_COMMAND_TIMEOUT_SECONDS = 20


class LocalConnectProxy(socketserver.ThreadingTCPServer):
    allow_reuse_address = True


class ConnectHandler(socketserver.BaseRequestHandler):
    def handle(self):
        request = self.request.recv(8192)
        if not request.startswith(b"CONNECT "):
            self.request.close()
            return
        target = request.split(b" ", 2)[1].decode("ascii", "replace")
        host, _, port_text = target.partition(":")
        port = int(port_text or "443")
        upstream = socket.create_connection(("127.0.0.1", 8443), timeout=15)
        try:
            self.request.sendall(b"HTTP/1.1 200 Connection Established\\r\\n\\r\\n")
            sockets = [self.request, upstream]
            while True:
                readable, _, _ = select.select(sockets, [], [], 30)
                if not readable:
                    return
                for source in readable:
                    data = source.recv(65536)
                    if not data:
                        return
                    (upstream if source is self.request else self.request).sendall(data)
        finally:
            upstream.close()
            self.request.close()


def certutil_run(arguments: list[str]) -> subprocess.CompletedProcess[bytes]:
    creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    certutil = shutil.which("certutil.exe")
    if not certutil:
        raise RuntimeError("Firefox trust setup unavailable: certutil.exe was not found")
    try:
        # certutil emits localized output and may wait on an inherited
        # console/store handle. Detach all standard streams so the bounded
        # trust setup cannot block before Firefox starts.
        return subprocess.run(
            [certutil, *arguments],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            text=False,
            timeout=CERTUTIL_TIMEOUT_SECONDS,
            creationflags=creationflags,
        )
    except subprocess.TimeoutExpired as error:
        raise RuntimeError(f"certutil timed out after {CERTUTIL_TIMEOUT_SECONDS}s: {' '.join(arguments[:4])}") from error


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
    # Do not probe the entire user Root store: on some Windows profiles a
    # thumbprint lookup can block behind the certificate UI/store lock. The
    # forced import is idempotent for this per-run CA and remains bounded.
    installed = certutil_run(["-f", "-user", "-addstore", "Root", str(ca_path)])
    if installed.returncode != 0:
        raw_detail = installed.stderr or installed.stdout or b"certutil addstore failed"
        detail = raw_detail.decode(errors="replace").strip().splitlines()[-1][:240]
        raise RuntimeError(f"certutil addstore failed ({installed.returncode}): {detail}")
    return thumbprint, True


def remove_windows_root(thumbprint: str, owned: bool) -> None:
    if not owned:
        return
    try:
        certutil_run(["-user", "-delstore", "Root", thumbprint])
    except RuntimeError:
        pass


def wait_for(wait: WebDriverWait, condition):
    return wait.until(condition)


def verify_cookie_jar_isolation(cookies_a: list[dict], cookies_b: list[dict], cookies_selector: list[dict], host_a: str, host_b: str) -> bool:
    def drill_cookie(cookies: list[dict], expected_value: str, expected_host: str) -> None:
        entries = [cookie for cookie in cookies if cookie.get("name") == "drill_node"]
        if len(entries) != 1 or entries[0].get("value") != expected_value:
            raise RuntimeError("browser cookie jar had the wrong node cookie")
        domain = str(entries[0].get("domain", "")).lstrip(".").lower()
        if domain != expected_host.lower():
            raise RuntimeError("browser drill cookie was not host-only for its node")

    drill_cookie(cookies_a, "A", host_a)
    drill_cookie(cookies_b, "B", host_b)
    if any(cookie.get("name") == "drill_node" for cookie in cookies_selector):
        raise RuntimeError("selector browser cookie jar received a downstream drill cookie")
    return True


def browser_text(driver, locator: tuple[str, str]) -> str:
    return driver.find_element(*locator).text.strip()


def wait_for_node_ids(driver, expected: list[str], stop_path: Path, log=None) -> bool:
    deadline = time.monotonic() + WAIT_SECONDS
    while time.monotonic() < deadline:
        if stop_path.exists():
            return False
        try:
            ids = {
                element.text.strip()
                for element in driver.find_elements(By.CSS_SELECTOR, ".node-id")
                if element.text.strip()
            }
            if log is not None:
                log(f"nodes-observed:count={len(ids)}:url={driver.current_url!r}")
            if all(node_id in ids for node_id in expected):
                return True
        except WebDriverException as error:
            if log is not None:
                log(f"nodes-observation-error:{type(error).__name__}")
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
    proxy_server = None
    try:
        proxy_server = LocalConnectProxy(("127.0.0.1", 0), ConnectHandler)
        proxy_thread = threading.Thread(target=proxy_server.serve_forever, daemon=True)
        proxy_thread.start()
        proxy_port = proxy_server.server_address[1]
        options = Options()
        options.add_argument("-profile")
        options.add_argument(str(profile_dir))
        options.set_preference("security.enterprise_roots.enabled", True)
        options.set_preference("network.trr.mode", 5)
        options.set_preference("network.proxy.type", 1)
        options.set_preference("network.proxy.share_proxy_settings", True)
        options.set_preference("network.proxy.http", "127.0.0.1")
        options.set_preference("network.proxy.http_port", proxy_port)
        options.set_preference("network.proxy.ssl", "127.0.0.1")
        options.set_preference("network.proxy.ssl_port", proxy_port)
        options.set_preference("network.proxy.no_proxies_on", "")
        options.accept_insecure_certs = False
        log("starting-firefox")
        service = Service(resolve_geckodriver(), log_output=str(gecko_log))
        driver = webdriver.Firefox(options=options, service=service, keep_alive=True)
        driver.command_executor._client_config.timeout = WEBDRIVER_COMMAND_TIMEOUT_SECONDS
        log("firefox-started")
        driver.set_page_load_timeout(60)
        wait = WebDriverWait(driver, WAIT_SECONDS, poll_frequency=POLL_SECONDS)

        # URL credentials exercise the real browser Basic Auth path without
        # logging or storing the password in any checkpoint. Warm a static
        # resource first so an application document never runs while its URL
        # still contains userinfo (Firefox rejects fetches in that state).
        gateway = bindings["gatewayUrl"]
        log("navigating-gateway-authenticated")
        gateway_warmup = gateway.rstrip("/") + "/styles.css"
        driver.get(gateway_warmup.replace("https://", "https://operator:drill-password@", 1))
        # Navigate to the same origin without userinfo after Firefox has
        # cached the real Basic Auth challenge response for this host.
        driver.get(gateway + "/")
        log(f"gateway-loaded:title={driver.title!r}:url={driver.current_url!r}")
        # Keep the management document active until its session and one-time
        # token checkpoints are complete. Selector and Node authorities are
        # authenticated later, after the browser receives their run bindings.
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
        open_urls = node_binding.get("openUrls")
        selector_url = node_binding.get("selectorUrl")
        if not isinstance(open_urls, dict) or not isinstance(open_urls.get("a"), str) or not isinstance(open_urls.get("b"), str) or not isinstance(selector_url, str):
            raise RuntimeError("node binding must contain selectorUrl and openUrls for both nodes")

        # Reload the clean management document instead of relying on a SPA
        # tab transition after token minting. The document bootstraps a fresh
        # authenticated session and loads the Nodes view deterministically.
        driver.get(gateway + "/")
        session_status = wait_for(wait, EC.visibility_of_element_located((By.ID, "session-status")))
        wait.until(lambda _driver: session_status.text.strip().startswith("operator:"))
        log("management-nodes-reloaded")
        if not wait_for_node_ids(driver, node_ids, stop_path, log=log):
            return 0
        node_elements = driver.find_elements(By.CSS_SELECTOR, ".node-id")
        visible_ids = {element.text.strip() for element in node_elements}
        if not set(node_ids).issubset(visible_ids):
            raise RuntimeError("current-run node IDs were not independently observed in the Nodes list")
        node_target = next((element for element in node_elements if element.text.strip() == node_ids[0]), None)
        if node_target is None:
            raise RuntimeError("current-run Node A detail target was not found in the observed Nodes list")
        log("node-detail-click-start")
        driver.execute_script("arguments[0].click()", node_target)
        log("node-detail-clicked")
        def detail_ready(_driver):
            detail_nodes = _driver.find_elements(By.ID, "node-detail-view")
            headings = _driver.find_elements(By.CSS_SELECTOR, "#node-detail-view h2")
            if len(detail_nodes) != 1:
                return False
            detail_node = detail_nodes[0]
            state = detail_node.get_attribute("data-detail-state")
            if state == "error":
                message = detail_node.text.strip().replace("\\n", " ")[:240]
                raise RuntimeError(f"node detail request failed for current-run node: {message!r}")
            if len(headings) != 1:
                return False
            return state == "ready" and detail_node.get_attribute("hidden") is None and headings[0].text.strip() == node_ids[0]

        detail_ready_wait = WebDriverWait(driver, 30, poll_frequency=0.5)
        if not detail_ready_wait.until(detail_ready):
            body = driver.find_element(By.TAG_NAME, "body").text.strip().replace("\\n", " ")[:240]
            raise RuntimeError(f"node detail did not render for current-run node: {body!r}")
        detail = driver.find_element(By.ID, "node-detail-view")
        if "Route Target" not in detail.text:
            raise RuntimeError("node detail did not expose Route Target")

        # The selector Open and cookie checks must be performed by this real
        # Firefox profile, not inferred from the selector JSON or response headers.
        # Warm the Basic Auth challenge independently for the selector and both
        # dynamic authorities before clicking their actual Open anchors. Use a
        # static resource for the challenge so no app script runs under URL
        # userinfo, then load each clean authority URL.
        for warm_url in [selector_url, open_urls["a"], open_urls["b"]]:
            authority_warmup = warm_url.rstrip("/") + "/styles.css"
            driver.get(authority_warmup.replace("https://", "https://operator:drill-password@", 1))
            driver.get(warm_url)
        driver.get(selector_url)
        wait_for(wait, EC.presence_of_element_located((By.ID, "selector-view")))
        cards = driver.find_elements(By.CSS_SELECTOR, ".selector-card")
        if len(cards) < 2:
            raise RuntimeError("selector did not render two endpoint cards")
        open_links = driver.find_elements(By.CSS_SELECTOR, "a.open-button")
        hrefs = {link.get_attribute("href") for link in open_links}
        if open_urls["a"] not in hrefs or open_urls["b"] not in hrefs:
            raise RuntimeError("selector Open hrefs did not match current-run bindings")
        driver.execute_script("arguments[0].click()", next(link for link in open_links if link.get_attribute("href") == open_urls["a"]))
        wait_for(wait, EC.presence_of_element_located((By.TAG_NAME, "body")))
        if not driver.current_url.startswith(open_urls["a"]):
            raise RuntimeError("browser Open A did not navigate to the bound authority")
        if node_ids[1] in driver.find_element(By.TAG_NAME, "body").text:
            raise RuntimeError("browser Open A displayed Node B content")
        selector_open_a = True
        driver.get(selector_url)
        wait_for(wait, EC.presence_of_element_located((By.ID, "selector-view")))
        open_links = driver.find_elements(By.CSS_SELECTOR, "a.open-button")
        driver.execute_script("arguments[0].click()", next(link for link in open_links if link.get_attribute("href") == open_urls["b"]))
        wait_for(wait, EC.presence_of_element_located((By.TAG_NAME, "body")))
        if not driver.current_url.startswith(open_urls["b"]):
            raise RuntimeError("browser Open B did not navigate to the bound authority")
        if node_ids[0] in driver.find_element(By.TAG_NAME, "body").text:
            raise RuntimeError("browser Open B displayed Node A content")
        selector_open_b = True

        driver.get(open_urls["a"])
        cookies_a = driver.get_cookies()
        driver.get(open_urls["b"])
        cookies_b = driver.get_cookies()
        driver.get(selector_url)
        selector_cookies = driver.get_cookies()
        node_a_host = urlparse(open_urls["a"]).hostname or ""
        node_b_host = urlparse(open_urls["b"]).hostname or ""
        cookie_isolated = verify_cookie_jar_isolation(cookies_a, cookies_b, selector_cookies, node_a_host, node_b_host)

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
            "selectorOpenAVerified": selector_open_a,
            "selectorOpenBVerified": selector_open_b,
            "cookieIsolationVerified": cookie_isolated,
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
        if proxy_server is not None:
            proxy_server.shutdown()
            proxy_server.server_close()
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
