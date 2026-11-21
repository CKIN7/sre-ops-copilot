import { READ_TOOL_NAMES } from "@beacon/core/schemas/tools";
import { WRITE_TOOL_NAMES } from "@beacon/core/schemas/writes";
import type { Client } from "pg";

/**
 * Identidad demo del control plane. Es dato sembrado, no configuración de
 * producción: el token de `AUTH_TOKENS_JSON` apunta a estos slugs y el API los
 * resuelve a UUIDs en cada request.
 */
export const DEMO_TENANT = {
  slug: "shop",
  name: "Shop (demo)",
} as const;

export const DEMO_USER = {
  email: "oncall@shop.test",
  displayName: "On-call demo",
} as const;

export const DEMO_AGENT = {
  name: "incident-copilot",
  model: "mock",
  promptVersion: "m2-v0",
  budgetCents: 10,
} as const;

export interface ControlPlaneIds {
  tenantId: string;
  userId: string;
  agentId: string;
}

/**
 * Siembra idempotente: reejecutar `pnpm db:seed` actualiza el agente sin borrar
 * runs ni cambiar los IDs, de modo que los tokens existentes siguen valiendo.
 */
export async function seedControlPlane(client: Client): Promise<ControlPlaneIds> {
  const tenantResult = await client.query<{ id: string }>(
    `insert into tenants (slug, name)
     values ($1, $2)
     on conflict (slug) do update set name = excluded.name
     returning id`,
    [DEMO_TENANT.slug, DEMO_TENANT.name],
  );
  const tenantId = tenantResult.rows[0]?.id;
  if (!tenantId) {
    throw new Error("control-plane seed: tenant insert returned no id");
  }

  const userResult = await client.query<{ id: string }>(
    `insert into users (tenant_id, email, display_name)
     values ($1, $2, $3)
     on conflict (tenant_id, email) do update set display_name = excluded.display_name
     returning id`,
    [tenantId, DEMO_USER.email, DEMO_USER.displayName],
  );
  const userId = userResult.rows[0]?.id;
  if (!userId) {
    throw new Error("control-plane seed: user insert returned no id");
  }

  const agentResult = await client.query<{ id: string }>(
    `insert into agents (tenant_id, name, model, prompt_version, allowed_tools, budget_cents)
     values ($1, $2, $3, $4, $5::text[], $6)
     on conflict (tenant_id, name) do update set
       model = excluded.model,
       prompt_version = excluded.prompt_version,
       allowed_tools = excluded.allowed_tools,
       budget_cents = excluded.budget_cents
     returning id`,
    [
      tenantId,
      DEMO_AGENT.name,
      DEMO_AGENT.model,
      DEMO_AGENT.promptVersion,
      // Las tools de escritura (fase 1) son de solo cálculo: el agente puede
      // proponer, no ejecutar. El `apply` no está en ninguna allowlist (ADR-004).
      [...READ_TOOL_NAMES, ...WRITE_TOOL_NAMES],
      DEMO_AGENT.budgetCents,
    ],
  );
  const agentId = agentResult.rows[0]?.id;
  if (!agentId) {
    throw new Error("control-plane seed: agent insert returned no id");
  }

  return { tenantId, userId, agentId };
}
