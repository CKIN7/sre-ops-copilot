export const SERVICE_SLUGS = [
  "edge",
  "web",
  "api",
  "checkout",
  "payments",
  "inventory",
] as const;

export type ServiceSlug = (typeof SERVICE_SLUGS)[number];

export type ServiceTier = "critical" | "standard" | "internal";

export interface ServiceDefinition {
  slug: ServiceSlug;
  displayName: string;
  role: string;
  tier: ServiceTier;
  ownerTeam: string;
  /**
   * Slugs de dependencia. Puede ser otro servicio sembrado o un sistema externo
   * (`psp-mock`, `db-primary`, `catalog`, `auth`) que no forma parte del inventario
   * sembrado; el grafo de `docs/plan.md` §1 incluye ambos casos.
   */
  dependsOn: readonly string[];
}

export const SERVICES: readonly ServiceDefinition[] = [
  {
    slug: "edge",
    displayName: "Edge gateway",
    role: "gateway/CDN",
    tier: "critical",
    ownerTeam: "edge-platform",
    dependsOn: ["web", "api"],
  },
  {
    slug: "web",
    displayName: "Storefront SSR",
    role: "frontend SSR",
    tier: "critical",
    ownerTeam: "web-experience",
    dependsOn: ["api"],
  },
  {
    slug: "api",
    displayName: "Public API",
    role: "API pública",
    tier: "critical",
    ownerTeam: "core-api",
    dependsOn: ["checkout", "catalog", "auth"],
  },
  {
    slug: "checkout",
    displayName: "Checkout",
    role: "pagos",
    tier: "critical",
    ownerTeam: "checkout-squad",
    dependsOn: ["payments", "inventory"],
  },
  {
    slug: "payments",
    displayName: "Payments adapter",
    role: "PSP adapter",
    tier: "critical",
    ownerTeam: "payments-squad",
    dependsOn: ["psp-mock"],
  },
  {
    slug: "inventory",
    displayName: "Inventory",
    role: "stock",
    tier: "standard",
    ownerTeam: "inventory-squad",
    dependsOn: ["db-primary"],
  },
];
