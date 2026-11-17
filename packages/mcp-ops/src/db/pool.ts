import { Pool } from "pg";

export function createPool(connectionString: string): Pool {
  return new Pool({
    connectionString,
    max: 4,
    application_name: "beacon-mcp-ops",
  });
}
