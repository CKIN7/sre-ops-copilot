import { runCli } from "./cli/main.js";

const exitCode = await runCli({
  argv: process.argv.slice(2),
  env: process.env,
  fetch: globalThis.fetch,
  io: {
    write: (text) => {
      process.stdout.write(text);
    },
    writeError: (text) => {
      process.stderr.write(text);
    },
  },
});

process.exitCode = exitCode;