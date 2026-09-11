// Shared TLS trust helper for v0.4 Hub<->Node private-CA support.
// Extra Orbit/operator CAs extend the runtime's normal default trust set;
// they never replace it and there is no skip-verification mode.

import tls from "node:tls";

export function extendDefaultCaCertificates(extraCertificates) {
  if (extraCertificates === null || extraCertificates === undefined) {
    return undefined;
  }
  const extras = Array.isArray(extraCertificates) ? extraCertificates : [extraCertificates];
  const defaults =
    typeof tls.getCACertificates === "function"
      ? tls.getCACertificates("default")
      : tls.rootCertificates;
  return [...defaults, ...extras];
}
