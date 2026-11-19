import { loadHttpConfig } from "./config.js";
import { createPool } from "./db/pool.js";
import { createOpsHttpHandler } from "./http/handler.js";
import { createNodeServer } from "./http/node.js";
import { SERVER_NAME } from "./meta.js";

const config = loadHttpConfig();
const pool = createPool(config.databaseUrl);
const handler = createOpsHttpHandler({
  pool,
  authToken: config.authToken,
  onError: (error) => {
    process.stderr.write(`[${SERVER_NAME}] error MCP: ${error.message}\n`);
  },
});
const server = createNodeServer(handler);

server.listen(config.port, config.host, () => {
  process.stderr.write(
    `[${SERVER_NAME}] MCP Streamable HTTP en http://${config.host}:${config.port}/mcp ` +
      `(revision 2026-07-28, sin sesiones)\n`,
  );
});

let closing = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (closing) {
    return;
  }
  closing = true;
  process.stderr.write(`[${SERVER_NAME}] ${signal} recibido, cerrando\n`);

  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  await handler.close();
  await pool.end();
}

process.once("SIGINT", () => {
  void shutdown("SIGINT");
});
process.once("SIGTERM", () => {
  void shutdown("SIGTERM");
});
