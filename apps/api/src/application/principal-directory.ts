import type { Principal } from "@beacon/core/domain/principal";

/** Slugs y email del token; nunca UUIDs ni datos que vengan del modelo. */
export interface PrincipalSelection {
  tenant: string;
  user: string;
  agent: string;
}

/** Configuración del agente necesaria para ejecutar un run. */
export interface AgentBinding {
  /** Nombre del agente en el control plane; es lo que se audita (`agent:<nombre>`). */
  name: string;
  model: string;
  promptVersion: string;
  allowedTools: readonly string[];
  /** Presupuesto de coste por run, en centimos. 0 = usar el limite por defecto. */
  budgetCents: number;
}

export interface ResolvedPrincipal {
  principal: Principal;
  agent: AgentBinding;
}

/**
 * Puerto de resolución de identidad. El adaptador Drizzle lo implementa; la
 * autenticación HTTP solo aporta la selección del token.
 */
export interface PrincipalDirectory {
  resolve(selection: PrincipalSelection): Promise<ResolvedPrincipal | null>;
}