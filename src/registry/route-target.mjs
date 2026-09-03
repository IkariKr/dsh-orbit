// Route Target validation for v0.4 Endpoint Selector (RFC-0010 D2).
// Only operator-approved server-reachable absolute origins are permitted.
// Non-loopback production targets require HTTPS; explicit loopback
// co-located targets may use HTTP. Paths, query strings, fragments,
// and embedded credentials are strictly forbidden.

function isLoopbackHostname(hostname) {
  return hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
}

export function validateRouteTargetOrigin(value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("route target is required");
  }
  const trimmed = value.trim();
  if (trimmed.includes("?") || trimmed.includes("#")) {
    throw new Error("route target must carry no query or fragment");
  }

  let url;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("route target is a malformed URL");
  }

  if (url.username !== "" || url.password !== "" || trimmed.includes("@")) {
    throw new Error("route target must not contain credentials");
  }

  if (url.pathname !== "/" && url.pathname !== "") {
    throw new Error("route target must carry no path");
  }

  if (url.protocol === "https:") {
    if (!url.hostname || url.hostname === "") {
      throw new Error("route target must specify a hostname");
    }
    return url.origin;
  }

  if (url.protocol === "http:") {
    if (isLoopbackHostname(url.hostname)) {
      return url.origin;
    }
    throw new Error("HTTPS is required for non-loopback route targets");
  }

  throw new Error(`route target protocol must be https or loopback http (got ${JSON.stringify(url.protocol)})`);
}
