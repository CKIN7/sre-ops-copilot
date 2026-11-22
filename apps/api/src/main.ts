import { NodeCommandRunner } from "@beacon/executors/command";
import { checkSandboxAvailable } from "@beacon/executors/sandbox";

import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();

// Con EXECUTOR=sandbox no se arranca a ciegas: si kubectl o el cluster no estan,
// la API falla cerrado en vez de descubrirlo en el primer rollback.
if (config.executor === "sandbox") {
  try {
    await checkSandboxAvailable(config.sandbox, new NodeCommandRunner());
  } catch (error) {
    console.error(
      `no se pudo arrancar con EXECUTOR=sandbox: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}

const { app, close } = createApp({
  config,
  logger: {
    level: config.logLevel,
    // pino redacta antes de escribir: un token en un header no llega al log.
    redact: {
      paths: [
        "req.headers.authorization",
        "req.headers.cookie",
        "res.headers['set-cookie']",
        "*.token",
        "*.authorization",
      ],
      censor: "[redacted]",
    },
  },
});

try {
  await app.listen({ host: "127.0.0.1", port: config.port });
  app.log.info(`API de Beacon en http://127.0.0.1:${config.port}`);
} catch (error) {
  app.log.error({ err: error }, "no se pudo arrancar la API");
  await close();
  process.exitCode = 1;
}

const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
  app.log.info({ signal }, "cerrando API");
  try {
    await close();
  } catch (error) {
    app.log.error({ err: error }, "fallo al cerrar la API");
    process.exitCode = 1;
  }
};

process.once("SIGINT", () => {
  void shutdown("SIGINT");
});
process.once("SIGTERM", () => {
  void shutdown("SIGTERM");
});