import { createServer } from "node:http";
import { config } from "./config.js";
import { handleHttp } from "./routes.js";
import { attachWebSocket } from "./ws.js";

const server = createServer((req, res) => {
  handleHttp(req, res).catch((err) => {
    if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "internal error", detail: String(err) }));
  });
});

attachWebSocket(server);

server.listen(config.port, config.host, () => {
  // eslint-disable-next-line no-console
  console.log(
    `ghostwire-social listening on http://${config.host}:${config.port}` +
      (config.publicUrl ? ` (public: ${config.publicUrl})` : "") +
      (config.adminToken ? "" : "  [admin routes disabled: set ADMIN_TOKEN]"),
  );
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
    // Force-exit if connections linger.
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
