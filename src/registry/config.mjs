// Hub deployment configuration validation (P2-05): the hub is a plain
// http listener by design; TLS termination belongs to the deployment
// gateway. A non-loopback bind without an explicit trusted mode is
// refused at startup — a configurable plain-HTTP public bind must never
// become the de-facto production deployment.

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost", "::ffff:127.0.0.1"]);

export function isLoopbackListen(host) {
  return LOOPBACK_HOSTS.has(host);
}

// Returns a list of human-readable configuration errors (empty when the
// configuration is acceptable for startup).
export function validateHubConfig({ listen, trustedExternalScheme, publicListener }) {
  const errors = [];
  if (typeof listen !== "string" || listen === "") {
    errors.push("DSH_ORBIT_HUB_LISTEN must be a hostname or address");
  } else if (!isLoopbackListen(listen) && publicListener !== true) {
    errors.push(
      `listener ${listen} is not loopback; non-loopback plain-HTTP listening requires DSH_ORBIT_HUB_PUBLIC_LISTENER=1 (TLS must terminate at a trusted deployment gateway)`,
    );
  }
  if (trustedExternalScheme !== "http" && trustedExternalScheme !== "https") {
    errors.push(`DSH_ORBIT_HUB_TRUSTED_SCHEME must be http or https (got ${JSON.stringify(trustedExternalScheme)})`);
  }
  return errors;
}