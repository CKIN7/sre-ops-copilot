import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { loadConfig } from "./config.js";
import { createPool } from "./db/pool.js";
import { registerTools } from "./tools/register.js";

export const SERVER_NAME = "beacon-mcp-ops";
export const SERVER_VERSION = "0.0.0";

const config = loadConfig();
const pool = createPool(config.databaseUrl);

// stdio reserva stdout para el protocolo: los logs van siempre a stderr.
const handle = serveStdio(
  () => {
    const server = new McpServer(
      { name: SERVER_NAME, version: SERVER_VERSION },
      { capabilities: { tools: {} } },
    );
    registerTools(server, pool);
    return server;
  },
  { legacy: "reject" },
);

process.stderr.write(`[${SERVER_NAME}] sirviendo MCP por stdio (revision 2026-07-28)\n`);

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  process.stderr.write(`[${SERVER_NAME}] ${signal} recibido, cerrando\n`);
  await handle.close();
  await pool.end();
}

process.once("SIGINT", () => {
  void shutdown("SIGINT");
});
process.once("SIGTERM", () => {
  void shutdown("SIGTERM");
});
