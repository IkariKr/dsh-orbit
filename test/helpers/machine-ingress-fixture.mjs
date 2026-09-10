import { createMachineIngressServer } from "../../src/registry/machine-ingress.mjs";

export async function startMachineIngress(upstream) {
  const server = createMachineIngressServer({
    listenPort: 0,
    listenHost: "127.0.0.1",
    upstream,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  return {
    server,
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(resolve);
    }),
  };
}
