import { and, eq } from "drizzle-orm";

import type {
  PrincipalDirectory,
  PrincipalSelection,
  ResolvedPrincipal,
} from "../application/principal-directory.js";
import type { Database } from "./db.js";
import { agents, tenants, users } from "./schema.js";

/**
 * Resuelve el token a UUIDs del control plane con una sola consulta. Si falta
 * cualquiera de los tres (tenant, usuario o agente), el principal no existe: el
 * borde responde 403 sin distinguir cuál falló.
 */
export class DrizzlePrincipalDirectory implements PrincipalDirectory {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  async resolve(selection: PrincipalSelection): Promise<ResolvedPrincipal | null> {
    const [row] = await this.#db
      .select({
        tenantId: tenants.id,
        userId: users.id,
        agentId: agents.id,
        model: agents.model,
        promptVersion: agents.promptVersion,
        allowedTools: agents.allowedTools,
      })
      .from(tenants)
      .innerJoin(users, eq(users.tenantId, tenants.id))
      .innerJoin(agents, eq(agents.tenantId, tenants.id))
      .where(
        and(
          eq(tenants.slug, selection.tenant),
          eq(users.email, selection.user),
          eq(agents.name, selection.agent),
        ),
      )
      .limit(1);

    if (!row) {
      return null;
    }

    return {
      principal: {
        tenantId: row.tenantId,
        userId: row.userId,
        agentId: row.agentId,
      },
      agent: {
        model: row.model,
        promptVersion: row.promptVersion,
        allowedTools: row.allowedTools,
      },
    };
  }
}