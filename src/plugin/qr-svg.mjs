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
export function generateQrSvg(text, options = {}) {
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
