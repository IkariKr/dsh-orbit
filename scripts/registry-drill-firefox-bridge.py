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
import re
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
from selenium.common.exceptions import UnexpectedAlertPresentException, WebDriverException
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

    def __init__(self, server_address, handler_class, upstream_port: int):
        self.upstream_port = upstream_port
        super().__init__(server_address, handler_class)


class ConnectHandler(socketserver.BaseRequestHandler):
    def handle(self):
        upstream = None
        try:
            request = self.request.recv(8192)
            if not request.startswith(b"CONNECT "):
                return
            target = request.split(b" ", 2)[1].decode("ascii", "replace")
            _host, _, port_text = target.partition(":")
            _port = int(port_text or "443")
            upstream = socket.create_connection(("127.0.0.1", self.server.upstream_port), timeout=15)
            self.request.sendall(b"HTTP/1.1 200 Connection Established\r\n\r\n")
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
        except (OSError, ValueError):
            # A browser-side cancellation is local to this CONNECT tunnel.
            # Never let a broken socket escape socketserver and kill the bridge.
            return
        finally:
            if upstream is not None:
                try:
                    upstream.close()
                except OSError:
                    pass
            try:
                self.request.close()
            except OSError:
                pass


def certutil_run(arguments: list[str]) -> subprocess.CompletedProcess[bytes]:
    creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0) | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
    certutil = shutil.which("certutil.exe")
    if not certutil:
        raise RuntimeError("Firefox trust setup unavailable: certutil.exe was not found")
    command = [certutil, *arguments]
    process = subprocess.Popen(
        command,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        creationflags=creationflags,
    )
    try:
        returncode = process.wait(timeout=CERTUTIL_TIMEOUT_SECONDS)
    except subprocess.TimeoutExpired as error:
        # Popen.wait(timeout=...) avoids subprocess.run's post-timeout
        # communicate() path, which can itself block when certutil has opened
        # a certificate UI/store handle. Kill the owned process and its tree,
        # then fail closed without waiting for inherited UI children.
        try:
            process.kill()
        except OSError:
            pass
        try:
            process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            if os.name == "nt":
                try:
                    subprocess.run(
                        ["taskkill.exe", "/PID", str(process.pid), "/T", "/F"],
                        stdin=subprocess.DEVNULL,
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL,
                        timeout=5,
                        check=False,
                        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                    )
                except (OSError, subprocess.TimeoutExpired):
                    pass
        raise RuntimeError(f"certutil timed out after {CERTUTIL_TIMEOUT_SECONDS}s: {' '.join(arguments[:4])}") from error
    return subprocess.CompletedProcess(command, returncode)


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


def redact_error_text(error: BaseException | str) -> str:
    message = str(error)
    message = re.sub(r"https?://[^/\\s:@]+:[^@\\s]+@", "https://<redacted>@", message)
    message = message.replace("operator:drill-password@", "<redacted>@")
    message = message.replace("drill-password", "<redacted>")
    return message[:500]


def safe_url_for_log(value: str) -> str:
    try:
        parsed = urlparse(value)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            return "<unavailable>"
        authority = parsed.hostname
        if parsed.port:
            authority += f":{parsed.port}"
        return f"{parsed.scheme}://{authority}{parsed.path or '/'}"
    except (TypeError, ValueError):
        return "<unavailable>"


def certificate_thumbprint(ca_path: Path) -> str:
    result = subprocess.run(
        ["openssl", "x509", "-in", str(ca_path), "-noout", "-fingerprint", "-sha1"],
        check=True,
        capture_output=True,
        text=True,
    )
    return result.stdout.strip().split("=", 1)[-1].replace(":", "").upper()


def root_anchor_present(thumbprint: str) -> bool:
    if os.name != "nt":
        return False
    probe = subprocess.run(
        ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", f"$ErrorActionPreference='Stop'; @(Get-ChildItem 'Cert:\\CurrentUser\\Root' | Where-Object {{$_.Thumbprint -eq '{thumbprint}'}}).Count"],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=CERTUTIL_TIMEOUT_SECONDS,
        text=True,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    return probe.returncode == 0 and probe.stdout.strip() == "1"


def install_windows_root(ca_path: Path) -> tuple[str, str]:
    """Reuse or install a uniquely identified drill CA and retain it explicitly."""
    thumbprint = certificate_thumbprint(ca_path)
    if root_anchor_present(thumbprint):
        return thumbprint, "preexisting"
    installed = certutil_run(["-f", "-user", "-addstore", "Root", str(ca_path)])
    if installed.returncode != 0:
        raw_detail = installed.stderr or installed.stdout or b"certutil addstore failed"
        detail = raw_detail.decode(errors="replace").strip().splitlines()[-1][:240]
        raise RuntimeError(f"certutil addstore failed ({installed.returncode}): {detail}")
    return thumbprint, "installed-retained"


def remove_windows_root(thumbprint: str, ownership: str) -> None:
    if ownership != "installed-retained" or os.name != "nt":
        return
    if not re.fullmatch(r"[0-9A-Fa-f]{40}", thumbprint):
        raise RuntimeError("owned drill Root anchor cleanup received an invalid thumbprint")
    if not root_anchor_present(thumbprint):
        return
    command = (
        "$ErrorActionPreference='Stop'; "
        f"$thumb='{thumbprint.upper()}'; "
        "$matches=@(Get-ChildItem 'Cert:\\CurrentUser\\Root' | Where-Object {$_.Thumbprint -eq $thumb}); "
        "if ($matches.Count -gt 1) { throw 'owned drill Root anchor was not unique' }; "
        "if ($matches.Count -eq 1) { "
        "  $path=$matches[0].PSPath; "
        "  try { Remove-Item -LiteralPath $path -Force -ErrorAction Stop } catch { "
        "    $remaining=@(Get-ChildItem 'Cert:\\CurrentUser\\Root' | Where-Object {$_.Thumbprint -eq $thumb}); "
        "    if ($remaining.Count -ne 0) { throw } "
        "  } "
        "}; "
        "if (@(Get-ChildItem 'Cert:\\CurrentUser\\Root' | Where-Object {$_.Thumbprint -eq $thumb}).Count -ne 0) { throw 'owned drill Root anchor remained after cleanup' }"
    )
    try:
        result = subprocess.run(
            ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", command],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=CERTUTIL_TIMEOUT_SECONDS,
            text=True,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except subprocess.TimeoutExpired as error:
        raise RuntimeError(f"owned drill Root anchor cleanup timed out for {thumbprint}") from error
    if result.returncode != 0:
        raise RuntimeError(f"owned drill Root anchor cleanup failed for {thumbprint}")


def wait_for(wait: WebDriverWait, condition):
    return wait.until(condition)


def wait_for_navigation_element(driver, by, value: str, label: str, log=None, timeout: int = 30, expected_path: str | None = None):
    def condition(current_driver):
        if expected_path is not None:
            current_url = current_driver.current_url
            if urlparse(current_url).path != expected_path:
                return False
        return EC.presence_of_element_located((by, value))(current_driver)

    try:
        element = WebDriverWait(driver, timeout, poll_frequency=POLL_SECONDS).until(condition)
    except Exception as error:
        try:
            snapshot = driver.execute_script(
                """
                return {
                  url: window.location.href,
                  readyState: document.readyState,
                  title: document.title,
                  bodyPresent: Boolean(document.body),
                };
                """
            )
        except Exception:
            snapshot = {}
        raise RuntimeError(f"{label} did not render before timeout: {snapshot!r}") from error
    if log is not None:
        log(f"{label}-ready:url={safe_url_for_log(driver.current_url)!r}:ready={driver.execute_script('return document.readyState')}")
    return element


def stop_owned_process(process, label: str) -> None:
    if process is None or process.poll() is not None:
        return
    try:
        process.terminate()
        process.wait(timeout=5)
    except (OSError, subprocess.TimeoutExpired):
        try:
            process.kill()
            process.wait(timeout=5)
        except (OSError, subprocess.TimeoutExpired):
            print(f"browser bridge: unable to stop {label}", file=sys.stderr, flush=True)


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


def selector_surface_snapshot(driver) -> dict:
    return driver.execute_script(
        """
        const cards = [...document.querySelectorAll('.selector-card')];
        const links = [...document.querySelectorAll('a.open-button')]
          .map((link) => link.getAttribute('href') || '');
        const errors = [...document.querySelectorAll('.banner.error[role=alert], .banner.auth-error[role=alert]')]
          .map((node) => node.textContent.trim())
          .filter(Boolean);
        return {
          cards: cards.length,
          links,
          errors,
          readyState: document.readyState,
        };
        """,
    )


def wait_for_selector_cards(driver, stop_path: Path, expected: int = 2, log=None) -> dict | bool:
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        if stop_path.exists():
            return False
        try:
            snapshot = selector_surface_snapshot(driver)
            if log is not None:
                log(
                    f"selector-surface-observed:cards={snapshot.get('cards', 0)}:"
                    f"links={len(snapshot.get('links', []))}:ready={snapshot.get('readyState', '')}"
                )
            if snapshot.get("errors"):
                message = snapshot["errors"][0][:240]
                raise RuntimeError(f"selector endpoint request failed: {message!r}")
            if snapshot.get("cards", 0) >= expected and len(snapshot.get("links", [])) >= expected:
                return snapshot
        except WebDriverException as error:
            if log is not None:
                log(f"selector-observation-error:{type(error).__name__}")
        time.sleep(0.5)
    raise RuntimeError(f"selector did not render {expected} endpoint cards before timeout")


def click_selector_link(driver, target_url: str, label: str, log=None) -> None:
    if log is not None:
        log(f"selector-click-start:{label}")
    result = driver.execute_script(
        """
        const target = arguments[0];
        const link = [...document.querySelectorAll('a.open-button')]
          .find((candidate) => candidate.getAttribute('href') === target);
        if (!link) return { found: false, hrefs: [...document.querySelectorAll('a.open-button')]
          .map((candidate) => candidate.getAttribute('href') || '') };
        link.click();
        return { found: true, href: link.getAttribute('href') };
        """,
        target_url,
    )
    if not result.get("found"):
        raise RuntimeError(f"selector {label} link did not match current-run binding")
    if log is not None:
        log(f"selector-click-done:{label}")


def wait_for_route_page(
    driver,
    expected_url: str,
    forbidden_text: str,
    expected_cookie_value: str,
    label: str,
    stop_path: Path,
    log=None,
) -> dict | bool:
    deadline = time.monotonic() + 30
    last_snapshot = None
    while time.monotonic() < deadline:
        if stop_path.exists():
            return False
        try:
            snapshot = driver.execute_script(
                """
                return {
                  url: window.location.href,
                  readyState: document.readyState,
                  body: document.body?.innerText || '',
                };
                """,
            )
            last_snapshot = snapshot
            if log is not None:
                log(
                    f"route-page-observed:{label}:url={snapshot.get('url', '')!r}:"
                    f"ready={snapshot.get('readyState', '')}:bodyBytes={len(snapshot.get('body', ''))}"
                )
            if (
                snapshot.get("url", "").startswith(expected_url)
                and snapshot.get("readyState") in {"interactive", "complete"}
                and forbidden_text not in snapshot.get("body", "")
                and any(cookie.get("name") == "drill_node" and cookie.get("value") == expected_cookie_value for cookie in driver.get_cookies())
            ):
                return snapshot
        except WebDriverException as error:
            if log is not None:
                log(f"route-page-observation-error:{label}:{type(error).__name__}")
        time.sleep(0.5)
    raise RuntimeError(
        f"browser {label} did not reach the bound route page before timeout: "
        f"last={last_snapshot!r}"
    )


def run(args: argparse.Namespace) -> int:
    log_path = Path(args.log_path)
    log_path.parent.mkdir(parents=True, exist_ok=True)

    def log(message: str) -> None:
        line = f"{utc_now()} {message}"
        print(line, file=sys.stderr, flush=True)
        with log_path.open("a", encoding="utf-8") as stream:
            stream.write(line + "\n")

    def redact_error(error: BaseException) -> str:
        return redact_error_text(error)

    def navigate(driver, url: str, label: str) -> None:
        log(f"navigation-start:{label}")
        for attempt in range(2):
            try:
                driver.get(url)
                break
            except UnexpectedAlertPresentException as error:
                if attempt == 0:
                    log(f"navigation-alert-dismissed:{label}")
                    try:
                        driver.switch_to.alert.dismiss()
                    except WebDriverException:
                        pass
                    continue
                log(f"navigation-failed:{label}:{type(error).__name__}:{redact_error(error)}")
                raise
            except Exception as error:
                log(f"navigation-failed:{label}:{type(error).__name__}:{redact_error(error)}")
                raise
        try:
            current_url = driver.current_url
        except WebDriverException:
            current_url = "<unavailable>"
        log(f"navigation-returned:{label}:url={safe_url_for_log(current_url)!r}")

    bindings = read_json(Path(args.bindings_path))
    gateway_url = bindings.get("gatewayUrl")
    parsed_gateway = urlparse(gateway_url or "")
    if parsed_gateway.scheme != "https" or not parsed_gateway.port:
        raise RuntimeError("gatewayUrl must contain an explicit HTTPS port")
    log("bindings-loaded")
    challenge = os.environ.get("DSH_ORBIT_BROWSER_CHALLENGE", "")
    if not challenge:
        raise RuntimeError("runner browser challenge is missing")
    challenge_digest = hashlib.sha256(challenge.encode("utf-8")).hexdigest()

    ca_path = Path(args.ca_path)
    log(f"installing-ca:{ca_path.name}")
    thumbprint, root_ownership = install_windows_root(ca_path)
    log(f"ca-trusted:{thumbprint}:{root_ownership}")
    profile_dir = Path(tempfile.mkdtemp(prefix="dsh-orbit-firefox-"))
    gecko_log = log_path.with_name("geckodriver.log")
    driver = None
    service = None
    proxy_server = None
    try:
        proxy_server = LocalConnectProxy(("127.0.0.1", 0), ConnectHandler, parsed_gateway.port)
        proxy_thread = threading.Thread(target=proxy_server.serve_forever, daemon=True)
        proxy_thread.start()
        proxy_port = proxy_server.server_address[1]
        options = Options()
        # Use Firefox's default normal navigation strategy. The drill must not
        # advance from warmup until the authenticated management document has
        # actually committed; a non-blocking page-load strategy leaves Selenium
        # on the previous /styles.css document while the SPA is still booting.
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
        try:
            driver = webdriver.Firefox(service=service, options=options)
        except Exception as error:
            log(f"firefox-start-failed:{type(error).__name__}:{redact_error(error)}")
            raise
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
        navigate(driver, gateway_warmup.replace("https://", "https://operator:drill-password@", 1), "gateway-warmup")
        # Navigate to the same origin without userinfo after Firefox has
        # cached the real Basic Auth challenge response for this host.
        navigate(driver, gateway + "/", "gateway-management")
        wait_for_navigation_element(driver, By.TAG_NAME, "body", "gateway-management", log=log, expected_path="/")
        wait_for_navigation_element(driver, By.ID, "session-status", "gateway-session", log=log, expected_path="/")
        log(f"gateway-loaded:title={driver.title!r}:url={driver.current_url!r}")
        # Keep the management document active until its session and one-time
        # token checkpoints are complete. Selector and Node authorities are
        # authenticated later, after the browser receives their run bindings.
        body_text = driver.find_element(By.TAG_NAME, "body").text.strip().replace("\\n", " ")[:160]
        log(f"gateway-body-prefix:{body_text!r}")
        session_status = wait_for(
            WebDriverWait(driver, 60, poll_frequency=POLL_SECONDS),
            EC.visibility_of_element_located((By.ID, "session-status")),
        )
        WebDriverWait(driver, 60, poll_frequency=POLL_SECONDS).until(
            lambda _driver: session_status.text.strip().startswith("operator:")
        )
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
            "rootAnchorOwnership": root_ownership,
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
        navigate(driver, gateway + "/", "gateway-management-reload")
        session_status = wait_for(
            WebDriverWait(driver, 60, poll_frequency=POLL_SECONDS),
            EC.visibility_of_element_located((By.ID, "session-status")),
        )
        WebDriverWait(driver, 60, poll_frequency=POLL_SECONDS).until(
            lambda _driver: session_status.text.strip().startswith("operator:")
        )
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
        detail_deadline = time.monotonic() + 30
        detail_state = "current-ui-dom"
        while time.monotonic() < detail_deadline:
            try:
                detail_nodes = driver.find_elements(By.ID, "node-detail-view")
                if len(detail_nodes) == 1:
                    detail_node = detail_nodes[0]
                    detail_snapshot = driver.execute_script(
                        """
                        const detail = document.getElementById('node-detail-view');
                        const heading = detail?.querySelector('h2');
                        return {
                          hidden: detail?.hidden === true || detail?.hasAttribute('hidden'),
                          heading: heading?.textContent?.trim() || '',
                          text: detail?.textContent || '',
                        };
                        """,
                    )
                    log(f"node-detail-snapshot:hidden={detail_snapshot.get('hidden')}:heading={detail_snapshot.get('heading')!r}")
                    if (
                        detail_snapshot.get("hidden") is False
                        and detail_snapshot.get("heading") == node_ids[0]
                        and "Route Target" in detail_snapshot.get("text", "")
                    ):
                        break
            except WebDriverException as error:
                log(f"node-detail-observation-error:{type(error).__name__}")
                raise RuntimeError(f"node detail browser observation failed: {type(error).__name__}") from error
            time.sleep(0.5)
        else:
            raise RuntimeError(f"node detail did not render for current-run node: state={detail_state or 'unset'}")
        log("node-detail-ready")

        # The selector Open and cookie checks must be performed by this real
        # Firefox profile, not inferred from the selector JSON or response headers.
        # Warm the Basic Auth challenge independently for the selector and both
        # dynamic authorities before clicking their actual Open anchors. Use a
        # static resource for the challenge so no app script runs under URL
        # userinfo, then load each clean authority URL.
        for label, warm_url in [("selector", selector_url), ("open-a", open_urls["a"]), ("open-b", open_urls["b"])]:
            authority_warmup = warm_url.rstrip("/") + "/styles.css"
            log(f"authority-warmup-start:{label}")
            navigate(driver, authority_warmup.replace("https://", "https://operator:drill-password@", 1), f"{label}-warmup")
            log(f"authority-warmup-loaded:{label}")
            navigate(driver, warm_url, f"{label}-authority")
            wait_for_navigation_element(driver, By.TAG_NAME, "body", f"authority-{label}", log=log)
            log(f"authority-loaded:{label}")
        log("selector-load-start")
        navigate(driver, selector_url, "selector")
        log("selector-load-complete")
        wait_for_navigation_element(driver, By.ID, "selector-view", "selector", log=log)
        selector_snapshot = wait_for_selector_cards(driver, stop_path, expected=2, log=log)
        if selector_snapshot is False:
            return 0
        hrefs = set(selector_snapshot.get("links", []))
        if open_urls["a"] not in hrefs or open_urls["b"] not in hrefs:
            raise RuntimeError("selector Open hrefs did not match current-run bindings")
        click_selector_link(driver, open_urls["a"], "open-a", log=log)
        route_a = wait_for_route_page(
            driver,
            open_urls["a"],
            node_ids[1],
            "A",
            "Open A",
            stop_path,
            log=log,
        )
        if route_a is False:
            return 0
        selector_open_a = True
        navigate(driver, selector_url, "selector-reload")
        wait_for_navigation_element(driver, By.ID, "selector-view", "selector-reload", log=log)
        selector_snapshot = wait_for_selector_cards(driver, stop_path, expected=2, log=log)
        if selector_snapshot is False:
            return 0
        click_selector_link(driver, open_urls["b"], "open-b", log=log)
        route_b = wait_for_route_page(
            driver,
            open_urls["b"],
            node_ids[0],
            "B",
            "Open B",
            stop_path,
            log=log,
        )
        if route_b is False:
            return 0
        selector_open_b = True

        log("cookie-isolation-start")
        navigate(driver, open_urls["a"], "cookie-open-a")
        wait_for_navigation_element(driver, By.TAG_NAME, "body", "cookie-open-a", log=log)
        cookies_a = driver.get_cookies()
        log(f"cookie-open-a-observed:count={len(cookies_a)}")
        navigate(driver, open_urls["b"], "cookie-open-b")
        wait_for_navigation_element(driver, By.TAG_NAME, "body", "cookie-open-b", log=log)
        cookies_b = driver.get_cookies()
        log(f"cookie-open-b-observed:count={len(cookies_b)}")
        navigate(driver, selector_url, "cookie-selector")
        wait_for_navigation_element(driver, By.ID, "selector-view", "cookie-selector", log=log)
        selector_cookies = driver.get_cookies()
        log(f"cookie-selector-observed:count={len(selector_cookies)}")
        node_a_host = urlparse(open_urls["a"]).hostname or ""
        node_b_host = urlparse(open_urls["b"]).hostname or ""
        log(
            "cookie-jars-before-verify:"
            f"a={[(cookie.get('name'), cookie.get('value'), cookie.get('domain')) for cookie in cookies_a]}:"
            f"b={[(cookie.get('name'), cookie.get('value'), cookie.get('domain')) for cookie in cookies_b]}:"
            f"selector={[(cookie.get('name'), cookie.get('value'), cookie.get('domain')) for cookie in selector_cookies]}"
        )
        cookie_isolated = verify_cookie_jar_isolation(cookies_a, cookies_b, selector_cookies, node_a_host, node_b_host)
        log("cookie-isolation-verified")

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
            "rootAnchorOwnership": root_ownership,
            "recordedAt": utc_now(),
        }
        write_json(Path(args.lifecycle_path), lifecycle)

        while not stop_path.exists():
            time.sleep(POLL_SECONDS)
        return 0
    finally:
        log("cleanup-start")
        if proxy_server is not None:
            try:
                proxy_server.shutdown()
                proxy_server.server_close()
                log("cleanup-proxy-done")
            except Exception as error:
                log(f"cleanup-proxy-failed:{type(error).__name__}:{redact_error(error)}")
                raise
        if driver is not None:
            quit_error = []

            def quit_driver() -> None:
                try:
                    driver.quit()
                except WebDriverException as error:
                    quit_error.append(error)

            quit_thread = threading.Thread(target=quit_driver, daemon=True)
            quit_thread.start()
            quit_thread.join(timeout=5)
            if quit_thread.is_alive():
                log("driver-quit-timeout; forcing owned geckodriver shutdown")
            elif quit_error:
                log(f"driver-quit-error:{type(quit_error[0]).__name__}")
            else:
                log("cleanup-driver-done")
        if service is not None:
            try:
                stop_owned_process(getattr(service, "process", None), "geckodriver")
                log("cleanup-geckodriver-done")
            except Exception as error:
                log(f"cleanup-geckodriver-failed:{type(error).__name__}:{redact_error(error)}")
                raise
        try:
            remove_windows_root(thumbprint, root_ownership)
            log(f"cleanup-root-done:{root_ownership}")
        except Exception as error:
            log(f"cleanup-root-failed:{type(error).__name__}:{redact_error(error)}")
            raise
        shutil.rmtree(profile_dir, ignore_errors=True)
        log("cleanup-profile-done")


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
        print(f"browser bridge failed: {type(error).__name__}: {redact_error_text(error)}", file=sys.stderr, flush=True)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
