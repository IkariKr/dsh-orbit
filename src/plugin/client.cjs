// DeepSeek Harness (DSH) Browser Client Bundle for dsh-orbit (RFC-0016 D4).
// Self-contained zero-dependency bundle registered via window.__ModuleLoader__.load.

(function () {
  'use strict';

// Zero-dependency pure JavaScript QR Code SVG Generator (RFC-0016 D4).
// Computes Galois Field GF(256) arithmetic, Reed-Solomon error correction,
// standard QR matrix layout (Versions 1-6), and emits clean inline vector <svg>.
//
// Strictly client-side: requires no external network requests or third-party APIs.

const GF256_EXP = new Uint8Array(512);
const GF256_LOG = new Uint8Array(256);

// Initialize Galois Field GF(2^8) with primitive polynomial x^8 + x^4 + x^3 + x^2 + 1 (0x11d)
(function initGf256() {
  let val = 1;
  for (let i = 0; i < 255; i++) {
    GF256_EXP[i] = val;
    GF256_EXP[i + 255] = val;
    GF256_LOG[val] = i;
    val = (val << 1) ^ (val & 0x80 ? 0x11d : 0);
  }
  GF256_LOG[0] = 0; // undefined mathematically, 0 for safety
})();

function gfMultiply(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF256_EXP[GF256_LOG[a] + GF256_LOG[b]];
}

// Compute Reed-Solomon generator polynomial of degree degree
function rsGeneratorPolynomial(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const factor = [1, GF256_EXP[i]];
    const newPoly = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      newPoly[j] ^= gfMultiply(poly[j], factor[0]);
      newPoly[j + 1] ^= gfMultiply(poly[j], factor[1]);
    }
    poly = newPoly;
  }
  return poly;
}

// Compute Reed-Solomon error correction codewords
function rsComputeCodewords(data, ecCount) {
  const genPoly = rsGeneratorPolynomial(ecCount);
  const remainder = new Array(ecCount).fill(0);

  for (let i = 0; i < data.length; i++) {
    const factor = data[i] ^ remainder[0];
    for (let j = 0; j < ecCount - 1; j++) {
      remainder[j] = remainder[j + 1] ^ gfMultiply(factor, genPoly[j + 1]);
    }
    remainder[ecCount - 1] = gfMultiply(factor, genPoly[ecCount]);
  }
  return remainder;
}

// Version table for Versions 1-6 (Error Correction Level L and M)
// format: [version, size, totalCodewords, dataCodewordsL, ecCodewordsL, numBlocksL, dataCodewordsM, ecCodewordsM, numBlocksM, alignPos]
const VERSION_SPECS = [
  // v1: 21x21
  { version: 1, size: 21, total: 26, L: { data: 19, ec: 7, blocks: 1 }, M: { data: 16, ec: 10, blocks: 1 }, align: [] },
  // v2: 25x25
  { version: 2, size: 25, total: 44, L: { data: 34, ec: 10, blocks: 1 }, M: { data: 28, ec: 16, blocks: 1 }, align: [6, 18] },
  // v3: 29x29
  { version: 3, size: 29, total: 70, L: { data: 55, ec: 15, blocks: 1 }, M: { data: 44, ec: 26, blocks: 1 }, align: [6, 22] },
  // v4: 33x33
  { version: 4, size: 33, total: 100, L: { data: 80, ec: 20, blocks: 1 }, M: { data: 64, ec: 18, blocks: 2 }, align: [6, 26] },
  // v5: 37x37
  { version: 5, size: 37, total: 134, L: { data: 108, ec: 26, blocks: 1 }, M: { data: 86, ec: 24, blocks: 2 }, align: [6, 30] },
  // v6: 41x41
  { version: 6, size: 41, total: 172, L: { data: 136, ec: 18, blocks: 2 }, M: { data: 108, ec: 16, blocks: 4 }, align: [6, 34] },
];

// Format info bit patterns for 15-bit BCH code (Mask 0-7, Level L and M)
// Level L = 01b, Level M = 00b
// BCH code generator polynomial: x^10 + x^8 + x^5 + x^4 + x^2 + x + 1 (0x537)
// Mask with 0x5412
function computeFormatBits(ecLevel, mask) {
  const levelBits = ecLevel === "M" ? 0b00 : 0b01;
  const data = (levelBits << 3) | mask;
  let rem = data << 10;
  for (let i = 14; i >= 10; i--) {
    if ((rem >> i) & 1) {
      rem ^= 0x537 << (i - 10);
    }
  }
  const format = ((data << 10) | rem) ^ 0x5412;
  return format;
}

/**
 * Encodes text into 8-bit byte mode QR bitstream.
 */
function encodeBitstream(text, version, ecLevel) {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(text);
  const spec = VERSION_SPECS.find((s) => s.version === version);
  const ecSpec = spec[ecLevel];
  const maxDataCodewords = ecSpec.data;

  // Header: 0100 (Byte mode) + 8-bit character count indicator (for v1-v9)
  const bitArray = [];
  const pushBits = (value, length) => {
    for (let i = length - 1; i >= 0; i--) {
      bitArray.push((value >> i) & 1);
    }
  };

  pushBits(0b0100, 4); // 8-bit byte mode
  pushBits(bytes.length, 8); // character count

  for (const b of bytes) {
    pushBits(b, 8);
  }

  // Terminator (up to 4 zeroes)
  const totalDataBits = maxDataCodewords * 8;
  const terminatorLen = Math.min(4, totalDataBits - bitArray.length);
  for (let i = 0; i < terminatorLen; i++) bitArray.push(0);

  // Pad to multiple of 8
  while (bitArray.length % 8 !== 0) bitArray.push(0);

  // Convert to codewords
  const codewords = [];
  for (let i = 0; i < bitArray.length; i += 8) {
    let byteVal = 0;
    for (let j = 0; j < 8; j++) {
      byteVal = (byteVal << 1) | bitArray[i + j];
    }
    codewords.push(byteVal);
  }

  // Pad with alternating 0xEC and 0x11 until capacity is reached
  const padBytes = [0xec, 0x11];
  let padIdx = 0;
  while (codewords.length < maxDataCodewords) {
    codewords.push(padBytes[padIdx]);
    padIdx = (padIdx + 1) % 2;
  }

  return { codewords, spec, ecSpec };
}

/**
 * Creates 2D matrix with function patterns (finder, timing, alignment, dark module).
 */
function createBaseMatrix(spec) {
  const size = spec.size;
  // matrix: null = unset, 0 = white, 1 = black
  const matrix = Array.from({ length: size }, () => new Array(size).fill(null));
  const isFunction = Array.from({ length: size }, () => new Array(size).fill(false));

  const setModule = (r, c, val) => {
    if (r >= 0 && r < size && c >= 0 && c < size) {
      matrix[r][c] = val ? 1 : 0;
      isFunction[r][c] = true;
    }
  };

  // 1. Finder patterns at (0,0), (size-7, 0), (0, size-7)
  const drawFinder = (top, left) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const row = top + r;
        const col = left + c;
        if (row < 0 || row >= size || col < 0 || col >= size) continue;
        if (r === -1 || r === 7 || c === -1 || c === 7) {
          setModule(row, col, 0); // separator
        } else if (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4)) {
          setModule(row, col, 1);
        } else {
          setModule(row, col, 0);
        }
      }
    }
  };

  drawFinder(0, 0);
  drawFinder(0, size - 7);
  drawFinder(size - 7, 0);

  // 2. Timing patterns on row 6 and col 6
  for (let i = 8; i < size - 8; i++) {
    setModule(6, i, i % 2 === 0 ? 1 : 0);
    setModule(i, 6, i % 2 === 0 ? 1 : 0);
  }

  // 3. Alignment patterns
  if (spec.align && spec.align.length > 0) {
    const coords = spec.align;
    for (const r of coords) {
      for (const c of coords) {
        // Skip if overlaps with finder patterns
        if (isFunction[r][c]) continue;
        for (let dr = -2; dr <= 2; dr++) {
          for (let dc = -2; dc <= 2; dc++) {
            const isBorder = Math.abs(dr) === 2 || Math.abs(dc) === 2;
            const isCenter = dr === 0 && dc === 0;
            setModule(r + dr, c + dc, isBorder || isCenter ? 1 : 0);
          }
        }
      }
    }
  }

  // 4. Dark module
  setModule(size - 8, 8, 1);

  // 5. Reserve format info areas
  for (let i = 0; i <= 8; i++) {
    if (!isFunction[8][i]) isFunction[8][i] = true;
    if (!isFunction[i][8]) isFunction[i][8] = true;
  }
  for (let i = size - 8; i < size; i++) {
    if (!isFunction[8][i]) isFunction[8][i] = true;
  }
  for (let i = size - 7; i < size; i++) {
    if (!isFunction[i][8]) isFunction[i][8] = true;
  }

  return { matrix, isFunction, size };
}

/**
 * Places data and error correction codewords in matrix using snake pattern.
 */
function placeDataBits(matrix, isFunction, allCodewords, size, maskIdx) {
  // Flatten codewords into bit stream
  const bits = [];
  for (const cw of allCodewords) {
    for (let i = 7; i >= 0; i--) {
      bits.push((cw >> i) & 1);
    }
  }

  let bitIdx = 0;
  let upward = true;

  // Move right to left, 2 columns at a time
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--; // Skip vertical timing pattern column

    const rows = upward
      ? Array.from({ length: size }, (_, i) => size - 1 - i)
      : Array.from({ length: size }, (_, i) => i);

    for (const row of rows) {
      for (const c of [col, col - 1]) {
        if (!isFunction[row][c]) {
          let bit = bitIdx < bits.length ? bits[bitIdx++] : 0;
          // Apply mask pattern
          // Mask 0: (row + col) % 2 === 0
          // Mask 1: row % 2 === 0
          const mask = maskIdx === 1 ? row % 2 === 0 : (row + c) % 2 === 0;
          if (mask) bit ^= 1;
          matrix[row][c] = bit;
        }
      }
    }
    upward = !upward;
  }
}

/**
 * Inscribes format information bits into matrix.
 */
function inscribeFormatInfo(matrix, size, formatBits) {
  const getBit = (idx) => (formatBits >> idx) & 1;

  // Top-left vertical & horizontal
  // [0..5] on row 8 col 0..5
  for (let i = 0; i <= 5; i++) matrix[8][i] = getBit(14 - i);
  matrix[8][7] = getBit(8);
  matrix[8][8] = getBit(7);
  matrix[7][8] = getBit(6);
  for (let i = 0; i <= 5; i++) matrix[5 - i][8] = getBit(i);

  // Split copies on bottom-left and top-right
  // Column 8, rows size-7 to size-1
  for (let i = 0; i <= 6; i++) {
    matrix[size - 1 - i][8] = getBit(i);
  }
  // Row 8, columns size-8 to size-1
  for (let i = 0; i <= 7; i++) {
    matrix[8][size - 8 + i] = getBit(7 + i);
  }
}

/**
 * Generates an inline vector SVG string for the given text.
 *
 * @param {string} text - Payload to encode (e.g. verified TLS pairing URL)
 * @param {object} [options]
 * @param {number} [options.margin=4] - Quiet zone margin in modules
 * @param {string} [options.foreground="#000000"] - Dark module color
 * @param {string} [options.background="#ffffff"] - Light background color
 * @param {string} [options.ecLevel="M"] - Error correction level ("L" or "M")
 * @param {number} [options.size=200] - Rendered pixel size for CSS width/height
 * @returns {{ svg: string, matrix: number[][], size: number, text: string }}
 */
function generateQrSvg(text, options = {}) {
  if (typeof text !== "string" || text.length === 0) {
    throw new Error("QR text payload must be a non-empty string");
  }

  const ecLevel = options.ecLevel === "L" ? "L" : "M";
  const margin = Number.isInteger(options.margin) && options.margin >= 0 ? options.margin : 4;
  const foreground = options.foreground || "#000000";
  const background = options.background || "#ffffff";
  const renderSize = options.size || 200;

  // Select smallest version that accommodates byte length
  const byteLen = new TextEncoder().encode(text).length;
  let matchedSpec = null;
  for (const s of VERSION_SPECS) {
    if (s[ecLevel].data >= byteLen + 3) {
      matchedSpec = s;
      break;
    }
  }

  if (!matchedSpec) {
    throw new Error(`Text payload too large for supported QR versions (byte length: ${byteLen})`);
  }

  const { codewords, spec, ecSpec } = encodeBitstream(text, matchedSpec.version, ecLevel);

  // Error correction blocks
  const blocks = ecSpec.blocks;
  const dataPerBlock = Math.floor(codewords.length / blocks);
  const ecPerBlock = ecSpec.ec;

  const blockData = [];
  const blockEc = [];

  for (let b = 0; b < blocks; b++) {
    const chunk = codewords.slice(b * dataPerBlock, (b + 1) * dataPerBlock);
    const ec = rsComputeCodewords(chunk, ecPerBlock);
    blockData.push(chunk);
    blockEc.push(ec);
  }

  // Interleave data and EC codewords
  const interleaved = [];
  for (let i = 0; i < dataPerBlock; i++) {
    for (let b = 0; b < blocks; b++) {
      if (i < blockData[b].length) interleaved.push(blockData[b][i]);
    }
  }
  for (let i = 0; i < ecPerBlock; i++) {
    for (let b = 0; b < blocks; b++) {
      if (i < blockEc[b].length) interleaved.push(blockEc[b][i]);
    }
  }

  // Layout matrix
  const { matrix, isFunction, size } = createBaseMatrix(spec);
  const maskIdx = 0; // Standard Mask 0: (row + col) % 2 === 0
  placeDataBits(matrix, isFunction, interleaved, size, maskIdx);

  const formatBits = computeFormatBits(ecLevel, maskIdx);
  inscribeFormatInfo(matrix, size, formatBits);

  // Render SVG path
  const totalDim = size + margin * 2;
  let pathOps = "";
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (matrix[r][c] === 1) {
        pathOps += `M${c + margin},${r + margin}h1v1h-1z `;
      }
    }
  }

  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${totalDim} ${totalDim}" width="${renderSize}" height="${renderSize}" shape-rendering="crispEdges">`,
    `  <rect width="100%" height="100%" fill="${background}"/>`,
    `  <path d="${pathOps.trim()}" fill="${foreground}"/>`,
    `</svg>`,
  ].join("\n");

  return {
    svg,
    matrix,
    size: totalDim,
    text,
  };
}


// DeepSeek Harness (DSH) Native Desktop Client UI Bundle (RFC-0016 D4, Stage 3).
// Injects the "Orbit Remote & Fleet" settings section into DSH's native settings
// using official extension point `slots.inject('settings.section')`.
//
// Strictly enforces verified TLS (https://) for remote QR pairing URLs.
// Generates inline vector SVG QR codes with zero external network requests.



const ORBIT_SETTINGS_SECTION_ID = "orbit-fleet";
const ORBIT_SETTINGS_SECTION_ORDER = 140;

/**
 * Controller and state manager for the Orbit Settings Section.
 * Encapsulates pairing code generation, countdown timers, SSE streaming,
 * and verified TLS assertion.
 */
class OrbitSettingsController {
  constructor(options = {}) {
    this.hubBaseUrl = options.hubBaseUrl || "";
    this.csrfToken = options.csrfToken || "";
    this.sessionCookie = options.sessionCookie || "";
    this.onStateChange = options.onStateChange || (() => {});
    this.now = options.now || (() => Date.now());

    this.state = {
      loading: false,
      error: null,
      code: null,
      url: null,
      expiresAt: null,
      remainingSeconds: 0,
      qrSvg: null,
      activeCodes: 0,
      activeSessions: 0,
      eventsConnected: false,
      devices: [],
    };

    this.timer = null;
    this.eventSource = null;
  }

  /**
   * Asserts that a URL uses verified TLS (https://).
   * Refuses unencrypted http:// schemes per RFC-0016 stop-work invariants.
   */
  assertVerifiedTls(urlStr) {
    if (!urlStr || typeof urlStr !== "string") {
      throw new Error("URL must be a non-empty string");
    }
    let parsed;
    try {
      parsed = new URL(urlStr);
    } catch {
      throw new Error(`Malformed URL: ${urlStr}`);
    }
    if (parsed.protocol !== "https:") {
      throw new Error(`Insecure transport scheme '${parsed.protocol}': QR pairing requires verified TLS (https://)`);
    }
    return parsed;
  }

  updateState(partial) {
    this.state = { ...this.state, ...partial };
    this.onStateChange(this.state);
  }

  /**
   * Generates a new 6-digit pairing code from the Hub (or local node).
   */
  async generateCode() {
    this.updateState({ loading: true, error: null });
    try {
      let data = null;

      if (this.hubBaseUrl) {
        const endpoint = `${this.hubBaseUrl}/hub/pairing/generate-code`;
        const res = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-csrf-token": this.csrfToken,
          },
        });

        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          throw new Error(errData.error?.message || `Failed to generate code (HTTP ${res.status})`);
        }

        data = await res.json();
      } else {
        // In-browser DSH node context: attempt hub route on current origin first
        let endpoint = "/hub/pairing/generate-code";
        let res = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-csrf-token": this.csrfToken,
          },
        }).catch(() => null);

        if (res && res.ok) {
          data = await res.json();
        } else {
          // If current origin does not serve /hub/pairing/generate-code (e.g. DSH node returning 405/404):
          // Generate node-scoped ephemeral 6-digit pairing code with verified TLS enforcement
          const loc = typeof window !== "undefined" && window.location ? window.location : null;
          const origin = loc ? loc.origin : "https://127.0.0.1";

          if (!origin.startsWith("https://")) {
            throw new Error(`Insecure transport scheme '${loc ? loc.protocol : "http:"}': QR pairing requires verified TLS (https://)`);
          }

          const code = Math.floor(100000 + Math.random() * 900000).toString();
          const expiresAt = new Date(this.now() + 300 * 1000).toISOString();
          const url = `${origin}/?token=${code}`;
          data = { code, expiresAt, url };
        }
      }

      // Enforce verified TLS invariant
      this.assertVerifiedTls(data.url);

      const qrResult = generateQrSvg(data.url, { size: 220 });
      const expiresAtMs = Date.parse(data.expiresAt);
      const remainingSeconds = Math.max(0, Math.floor((expiresAtMs - this.now()) / 1000));

      this.updateState({
        loading: false,
        code: data.code,
        url: data.url,
        expiresAt: data.expiresAt,
        remainingSeconds,
        qrSvg: qrResult.svg,
        error: null,
      });

      this.startCountdown(expiresAtMs);
    } catch (err) {
      this.updateState({
        loading: false,
        error: err.message,
      });
    }
  }

  startCountdown(expiresAtMs) {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => {
      const remaining = Math.max(0, Math.floor((expiresAtMs - this.now()) / 1000));
      if (remaining <= 0) {
        clearInterval(this.timer);
        this.timer = null;
        this.updateState({
          remainingSeconds: 0,
          code: null,
          url: null,
          qrSvg: null,
          error: "Pairing code expired. Please generate a new code.",
        });
      } else {
        this.updateState({ remainingSeconds: remaining });
      }
    }, 1000);
  }

  /**
   * Fetches status of active codes and sessions from Hub.
   */
  async fetchStatus() {
    try {
      const res = await fetch(`${this.hubBaseUrl}/hub/pairing/status`, {
        headers: {
          "x-csrf-token": this.csrfToken,
        },
      });
      if (res.ok) {
        const data = await res.json();
        this.updateState({
          activeCodes: data.activeCodes ?? 0,
          activeSessions: data.activeSessions ?? 0,
        });
      }
    } catch (err) {
      // Non-blocking background status fetch
    }
  }

  /**
   * Subscribes to Hub real-time SSE stream.
   */
  subscribeEvents() {
    if (this.eventSource) return;
    try {
      const streamUrl = `${this.hubBaseUrl}/hub/pairing/events`;
      const EventSourceClass = typeof window !== "undefined" ? window.EventSource : globalThis.EventSource;
      if (!EventSourceClass) return;

      this.eventSource = new EventSourceClass(streamUrl);
      this.eventSource.onopen = () => {
        this.updateState({ eventsConnected: true });
      };

      this.eventSource.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data);
          if (payload.type === "device-connected" || payload.event === "device-connected") {
            // A mobile client successfully verified the pairing code!
            // Clear current code and refresh status
            if (this.timer) {
              clearInterval(this.timer);
              this.timer = null;
            }
            const connectedDevice = {
              operatorPrincipal: payload.operatorPrincipal || "operator",
              clientIp: payload.clientIp || "unknown",
              connectedAt: payload.timestamp || new Date(this.now()).toISOString(),
            };
            this.updateState({
              code: null,
              url: null,
              qrSvg: null,
              remainingSeconds: 0,
              devices: [...this.state.devices, connectedDevice],
            });
            this.fetchStatus();
          }
        } catch {}
      };

      this.eventSource.onerror = () => {
        this.updateState({ eventsConnected: false });
      };
    } catch {}
  }

  /**
   * Renders HTML markup for the Settings Section card.
   */
  renderHtml() {
    const {
      loading,
      error,
      code,
      remainingSeconds,
      qrSvg,
      activeCodes,
      activeSessions,
      devices = [],
    } = this.state;

    return `
<div class="orbit-settings-section" id="orbit-settings-container">
  <style>
    .orbit-settings-section {
      font-family: inherit;
      color: var(--text-color, #1f2328);
      max-width: 600px;
    }
    .orbit-header {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 16px;
    }
    .orbit-header h3 {
      margin: 0;
      font-size: 20px;
      font-weight: 600;
      color: inherit;
    }
    .orbit-badge {
      background: #0969da;
      color: #ffffff;
      font-size: 11px;
      font-weight: 600;
      padding: 2px 8px;
      border-radius: 12px;
      letter-spacing: 0.5px;
    }
    .orbit-badge-green {
      background: #1f883d;
      color: #ffffff;
      font-size: 11px;
      font-weight: 600;
      padding: 2px 8px;
      border-radius: 12px;
    }
    .orbit-status-bar {
      display: flex;
      flex-wrap: wrap;
      gap: 16px;
      font-size: 13px;
      padding: 10px 14px;
      background: rgba(127, 127, 127, 0.08);
      border-radius: 8px;
      margin-bottom: 20px;
      align-items: center;
    }
    .orbit-pairing-card {
      border: 1px solid rgba(127, 127, 127, 0.2);
      border-radius: 10px;
      padding: 20px;
      background: rgba(127, 127, 127, 0.03);
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);
    }
    .orbit-pairing-card h4 {
      margin: 0 0 6px 0;
      font-size: 16px;
      font-weight: 600;
    }
    .orbit-pairing-card p {
      margin: 0 0 16px 0;
      font-size: 13px;
      color: rgba(127, 127, 127, 0.85);
      line-height: 1.5;
    }
    .orbit-code-display {
      display: flex;
      flex-direction: column;
      align-items: center;
      margin: 16px 0;
      padding: 12px;
      background: rgba(127, 127, 127, 0.05);
      border-radius: 8px;
    }
    .orbit-code-digits {
      font-size: 36px;
      font-weight: 700;
      letter-spacing: 6px;
      font-family: monospace;
      color: #0969da;
    }
    .orbit-countdown {
      font-size: 12px;
      color: #cf222e;
      margin-top: 6px;
      font-weight: 500;
    }
    .orbit-qr-container {
      display: flex;
      justify-content: center;
      margin: 16px 0;
      background: #ffffff;
      padding: 12px;
      border-radius: 8px;
      width: fit-content;
      margin-left: auto;
      margin-right: auto;
      box-shadow: 0 1px 4px rgba(0,0,0,0.1);
    }
    .orbit-idle-display {
      padding: 16px;
      text-align: center;
      color: rgba(127, 127, 127, 0.7);
      font-size: 13px;
      border: 1px dashed rgba(127, 127, 127, 0.3);
      border-radius: 8px;
      margin-bottom: 16px;
    }
    .orbit-btn-primary {
      background: #1f883d;
      color: #ffffff;
      border: none;
      border-radius: 6px;
      padding: 9px 18px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      transition: background 0.15s;
    }
    .orbit-btn-primary:hover {
      background: #1a7f37;
    }
    .orbit-btn-primary:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }
    .orbit-error-alert {
      background: #ffebe9;
      color: #cf222e;
      border: 1px solid #ff8182;
      border-radius: 6px;
      padding: 10px 14px;
      margin-bottom: 16px;
      font-size: 13px;
    }
    .orbit-devices-card {
      margin-top: 24px;
    }
    .orbit-devices-card h4 {
      margin: 0 0 10px 0;
      font-size: 15px;
      font-weight: 600;
    }
    .orbit-devices-list {
      list-style: none;
      padding: 0;
      margin: 0;
    }
    .orbit-devices-list li {
      padding: 10px 14px;
      border: 1px solid rgba(127, 127, 127, 0.2);
      border-radius: 6px;
      margin-bottom: 6px;
      display: flex;
      justify-content: space-between;
      font-size: 13px;
      align-items: center;
    }
  </style>

  <div class="orbit-header">
    <h3>Orbit Remote & Fleet</h3>
    <span class="orbit-badge">v0.9</span>
    <span class="orbit-badge-green">Tailscale Active</span>
  </div>
  
  <div class="orbit-status-bar">
    <span>Active Codes: <strong>${activeCodes}</strong></span>
    <span>Active Sessions: <strong>${activeSessions}</strong></span>
  </div>

  ${error ? `<div class="orbit-error-alert">${escapeHtml(error)}</div>` : ""}

  <div class="orbit-pairing-card">
    <h4>Mobile Quick Pair</h4>
    <p>Scan with Orbit Mobile to authorize an operator session.</p>

    ${
      code
        ? `
      <div class="orbit-code-display">
        <span class="orbit-code-digits">${code.slice(0, 3)} ${code.slice(3)}</span>
        <span class="orbit-countdown">Valid for ${remainingSeconds}s</span>
      </div>
      <div class="orbit-qr-container">
        ${qrSvg || ""}
      </div>
    `
        : `
      <div class="orbit-idle-display">
        <p>No active pairing code.</p>
      </div>
    `
    }

    <div class="orbit-actions">
      <button class="orbit-btn-primary" id="orbit-btn-generate" ${loading ? "disabled" : ""}>
        ${loading ? "Generating..." : code ? "Refresh Code" : "Pair Mobile Device"}
      </button>
    </div>
  </div>

  ${
    devices && devices.length > 0
      ? `
  <div class="orbit-devices-card">
    <h4>Connected Devices</h4>
    <ul class="orbit-devices-list">
      ${devices
        .map(
          (d) =>
            `<li><span>${escapeHtml(d.operatorPrincipal)}</span> <small>(${escapeHtml(d.clientIp)})</small></li>`,
        )
        .join("")}
    </ul>
  </div>
  `
      : ""
  }
</div>
`.trim();
  }

  destroy() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
  }
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

var _React = null;

/**
 * React Component conforming to DSH settings.section slot contract.
 */
function OrbitSettingsSection(props) {
  var React = _React || (typeof require === "function" ? require("react") : null) || globalThis.React || (typeof window !== "undefined" ? window.React : null);
  if (!React || !React.useRef || !React.useEffect) {
    return null;
  }
  var ref = React.useRef(null);
  React.useEffect(function () {
    var container = ref.current;
    if (!container) return;
    var controller = new OrbitSettingsController({
      onStateChange: function () {
        if (container) {
          container.innerHTML = controller.renderHtml();
          attachEventListeners(container, controller);
        }
      },
    });
    container.innerHTML = controller.renderHtml();
    attachEventListeners(container, controller);
    controller.fetchStatus();
    return function () {
      controller.destroy();
    };
  }, []);

  return React.createElement("div", {
    ref: ref,
    className: "orbit-settings-root",
    style: {
      padding: "24px 32px",
      height: "100%",
      overflowY: "auto",
      color: "var(--dsh-color-text, #1f2328)",
      fontFamily: "system-ui, -apple-system, sans-serif"
    }
  });
}

OrbitSettingsSection.Controller = OrbitSettingsController;
OrbitSettingsSection.render = function (container, options) {
  if (options === void 0) { options = {}; }
  var controller = new OrbitSettingsController(Object.assign({}, options, {
    onStateChange: function () {
      if (container) {
        container.innerHTML = controller.renderHtml();
        attachEventListeners(container, controller);
      }
    },
  }));
  if (container) {
    container.innerHTML = controller.renderHtml();
    attachEventListeners(container, controller);
  }
  return controller;
};

function attachEventListeners(container, controller) {
  const btn = container.querySelector("#orbit-btn-generate");
  if (btn) {
    btn.onclick = () => controller.generateCode();
  }
}

/**
 * DSH Client Plugin Entrypoint.
 * Injects into `slots.inject('settings.section')`.
 *
 * @param {object} ctx - DSH client context
 */
function apply(ctx) {
  if (typeof window === "undefined" && typeof globalThis.window === "undefined") {
    // SSR / Node safe guard
    return;
  }

  const slots = ctx && typeof ctx.get === "function" ? ctx.get("slots") : ctx?.slots;

  if (slots && typeof slots.inject === "function") {
    slots.inject("settings.section", function () {
      if (typeof slots.register === "function") {
        return slots.register(
          {
            name: "settings.section",
            id: ORBIT_SETTINGS_SECTION_ID,
            order: ORBIT_SETTINGS_SECTION_ORDER,
            label: () => "Orbit Remote & Fleet",
          },
          OrbitSettingsSection,
        );
      }
    });
  }
}




  var clientExports = {
    ORBIT_SETTINGS_SECTION_ID: ORBIT_SETTINGS_SECTION_ID,
    ORBIT_SETTINGS_SECTION_ORDER: ORBIT_SETTINGS_SECTION_ORDER,
    OrbitSettingsController: OrbitSettingsController,
    OrbitSettingsSection: OrbitSettingsSection,
    apply: apply,
    generateQrSvg: generateQrSvg,
  };

  if (typeof window !== 'undefined' && window.__ModuleLoader__ && typeof window.__ModuleLoader__.load === 'function') {
    window.__ModuleLoader__.load({
      id: 'dsh-orbit',
      factory: function (require) {
        if (typeof require === 'function') {
          try { _React = require('react'); } catch (e) {}
        }
        return clientExports;
      },
    });
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = clientExports;
  }
})();
