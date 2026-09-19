// Minimal RFC 6455 WebSocket codec for the v0.5 reverse transport
// (RFC-0012 D4/D5). Both sides run over verified TLS controlled by the
// existing trust policy — this module only frames bytes:
//   - server frames are unmasked, client frames are masked (RFC 6455 §5.3);
//   - fragmentation (continuation frames) is supported for data frames;
//   - control frames (ping/pong/close) are handled per spec.
// The reverse control channel carries only small UTF-8 JSON control
// messages; oversized messages fail closed instead of growing buffers.

import { createHash, randomBytes } from "node:crypto";

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

const OPCODE_CONTINUATION = 0x0;
const OPCODE_TEXT = 0x1;
const OPCODE_BINARY = 0x2;
const OPCODE_CLOSE = 0x8;
const OPCODE_PING = 0x9;
const OPCODE_PONG = 0xa;

export function computeSecWebSocketAccept(secWebSocketKey) {
  return createHash("sha1").update(`${secWebSocketKey}${WEBSOCKET_GUID}`).digest("base64");
}

export function randomSecWebSocketKey() {
  return randomBytes(16).toString("base64");
}

// Encode one frame. payloadMasked is required for CLIENT frames (RFC 6455
// §5.3) and forbidden for server frames.
export function encodeFrame({ opcode, payload = Buffer.alloc(0), mask = false }) {
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = (mask ? 0x80 : 0x00) | length;
  } else if (length < 65_536) {
    header = Buffer.alloc(4);
    header[1] = (mask ? 0x80 : 0x00) | 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = (mask ? 0x80 : 0x00) | 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  header[0] = 0x80 | opcode; // FIN set: one frame per message on send
  if (!mask) {
    return Buffer.concat([header, payload]);
  }
  const maskingKey = randomBytes(4);
  const masked = Buffer.alloc(length);
  for (let i = 0; i < length; i += 1) {
    masked[i] = payload[i] ^ maskingKey[i % 4];
  }
  return Buffer.concat([header, maskingKey, masked]);
}

// Streaming frame parser. Feed raw socket chunks; callbacks fire per
// complete frame. `maxMessageBytes` bounds reassembled data messages;
// control frames are bounded at 128 bytes per RFC 6455 §5.5.
export function createFrameParser({ isClient = false, maxMessageBytes = 64 * 1024, onMessage, onPing, onPong, onClose, onError }) {
  let buffer = Buffer.alloc(0);
  let fragments = [];
  let fragmentOpcode = null;
  let fragmentBytes = 0;
  let failed = false;

  const fail = (message) => {
    if (failed) return;
    failed = true;
    onError?.(new Error(message));
  };

  const handleData = (opcode, payload) => {
    if (opcode === OPCODE_TEXT || opcode === OPCODE_BINARY) {
      onMessage?.(opcode === OPCODE_TEXT ? payload.toString("utf8") : payload);
      return;
    }
    if (opcode === OPCODE_CLOSE) {
      onClose?.(payload.length >= 2 ? payload.readUInt16BE(0) : 1005);
      return;
    }
    if (opcode === OPCODE_PING) {
      onPing?.(payload);
      return;
    }
    if (opcode === OPCODE_PONG) {
      onPong?.(payload);
    }
  };

  return function feed(chunk) {
    if (failed) return;
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      if (buffer.length < 2) return;
      const first = buffer[0];
      const second = buffer[1];
      const fin = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      if (isClient && masked) {
        fail("server frames must not be masked");
        return;
      }
      if (!isClient && !masked) {
        fail("client frames must be masked");
        return;
      }
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < offset + 2) return;
        length = buffer.readUInt16BE(offset);
        offset += 2;
      } else if (length === 127) {
        if (buffer.length < offset + 8) return;
        const big = buffer.readBigUInt64BE(offset);
        if (big > BigInt(maxMessageBytes)) {
          fail("frame exceeds the message size cap");
          return;
        }
        length = Number(big);
        offset += 8;
      }
      const maskingKey = masked ? buffer.subarray(offset, offset + 4) : null;
      if (maskingKey) offset += 4;
      if (length > maxMessageBytes) {
        fail("frame exceeds the message size cap");
        return;
      }
      if (buffer.length < offset + length) return;
      let payload = Buffer.from(buffer.subarray(offset, offset + length));
      if (maskingKey) {
        for (let i = 0; i < payload.length; i += 1) {
          payload[i] ^= maskingKey[i % 4];
        }
      }
      buffer = buffer.subarray(offset + length);

      if (opcode >= 0x8) {
        // Control frames: FIN must be set and length <= 125 (§5.5.1).
        if (!fin || payload.length > 125) {
          fail("invalid control frame");
          return;
        }
        handleData(opcode, payload);
        continue;
      }
      if (opcode === OPCODE_CONTINUATION) {
        if (fragmentOpcode === null) {
          fail("continuation without an initial fragment");
          return;
        }
        fragments.push(payload);
        fragmentBytes += payload.length;
        if (fragmentBytes > maxMessageBytes) {
          fail("fragmented message exceeds the message size cap");
          return;
        }
        if (fin) {
          const whole = Buffer.concat(fragments);
          const base = fragmentOpcode;
          fragments = [];
          fragmentOpcode = null;
          fragmentBytes = 0;
          handleData(base, whole);
        }
        continue;
      }
      if (fragmentOpcode !== null) {
        fail("new data frame during fragmentation");
        return;
      }
      if (fin) {
        handleData(opcode, payload);
        continue;
      }
      fragmentOpcode = opcode;
      fragments = [payload];
      fragmentBytes = payload.length;
    }
  };
}
