// In-process stand-in for the deployed admission chain, used by the 0.1.5
// smoke-qualification acceptance. It composes two reviewed roles in one
// listener, exactly as the deployment composes them:
//   gateway hop  — local Basic Auth enforcement (the candidate gateway's
//                  supported auth path)
//   adapter hop  — the node-local DSH compatibility adapter contract
//                  (RFC-0003/RFC-0010): strip client-supplied proof headers,
//                  inject the node's proof and the forwarded scheme, present
//                  DSH's configured public host authority
// WebSocket upgrades are forwarded at the raw socket level so the 101
// handshake is end-to-end against the real process.

import http from "node:http";
import net from "node:net";

export function createCompatAdapterEmulator({ dshPort, publicHost, proxySecret, basicUser, basicPassword }) {
  const validBasic = `Basic ${Buffer.from(`${basicUser}:${basicPassword}`).toString("base64")}`;

  const rewriteHeaders = (headers) => {
    const forwarded = { ...headers };
    delete forwarded.host;
    delete forwarded.authorization;
    forwarded["x-forwarded-proto"] = "https";
    forwarded["x-dsh-orbit-authenticated-proxy"] = proxySecret;
    forwarded.host = publicHost;
    return forwarded;
  };

  const server = http.createServer((req, res) => {
    if (req.headers.authorization !== validBasic) {
      res.writeHead(401, { "www-authenticate": 'Basic realm="orbit-compat-adapter"' });
      res.end("the gateway rejected the request before DSH");
      return;
    }
    const upstream = http.request(
      { host: "127.0.0.1", port: dshPort, path: req.url, method: req.method, headers: rewriteHeaders(req.headers) },
      (up) => {
        res.writeHead(up.statusCode, up.headers);
        up.pipe(res);
      },
    );
    upstream.on("error", (error) => {
      res.writeHead(502);
      res.end(`compat adapter upstream error: ${error.message}`);
    });
    req.pipe(upstream);
  });

  server.on("upgrade", (req, socket, head) => {
    if (req.headers.authorization !== validBasic) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const forwarded = rewriteHeaders(req.headers);
    delete forwarded.upgrade;
    delete forwarded["sec-websocket-key"];
    delete forwarded["sec-websocket-version"];
    delete forwarded["sec-websocket-extensions"];
    const lines = Object.entries(forwarded).map(([name, value]) => `${name}: ${value}`);
    const raw =
      `${req.method} ${req.url} HTTP/1.1\r\n` +
      "connection: Upgrade\r\n" +
      "upgrade: websocket\r\n" +
      `sec-websocket-key: ${req.headers["sec-websocket-key"]}\r\n` +
      `sec-websocket-version: ${req.headers["sec-websocket-version"]}\r\n` +
      `${lines.join("\r\n")}\r\n\r\n`;
    const upstream = net.connect(dshPort, "127.0.0.1", () => {
      upstream.write(raw);
      if (head?.length) upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
  });

  return {
    listen() {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve(server.address().port));
      });
    },
    close() {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
