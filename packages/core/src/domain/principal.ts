/**
 * Identidad resuelta en el servidor (docs/plan.md §4.1).
 *
 * El modelo nunca aporta `tenantId`, `userId` ni `agentId`: llegan de la sesión
 * autenticada y se inyectan en el gateway y en el repositorio.
 */
export interface Principal {
  tenantId: string;
  userId: string;
  agentId: string;
}
