import type { ToolName } from "@beacon/core/schemas/tools";
import { TOOL_DESCRIPTIONS, TOOL_TITLES } from "@beacon/mcp-ops/tools/registry";

import type { Capability } from "./types.js";

/**
 * Catalogo de tools que ve el modelo de eval.
 *
 * Las descripciones salen de `@beacon/mcp-ops/tools/registry`: el mismo texto que
 * publica el servidor MCP. No es una copia de conveniencia; es el contrato del que
 * depende la seleccion de tool. El meta-eval muta una entrada de este catalogo y
 * comprueba que los casos que la necesitan fallan.
 */
export interface ToolCatalogEntry {
  name: ToolName;
  title: string;
  description: string;
}

export type ToolCatalog = readonly ToolCatalogEntry[];

export function defaultCatalog(): ToolCatalog {
  return (Object.keys(TOOL_DESCRIPTIONS) as ToolName[]).map((name) => ({
    name,
    title: TOOL_TITLES[name],
    description: TOOL_DESCRIPTIONS[name],
  }));
}

export function withCatalogOverrides(
  overrides: Partial<Record<ToolName, string>>,
): ToolCatalog {
  return defaultCatalog().map((entry) => ({
    ...entry,
    description: overrides[entry.name] ?? entry.description,
  }));
}

interface CapabilitySpec {
  /** Tools candidatas; el orden es el desempate cuando varias encajan. */
  tools: readonly ToolName[];
  /**
   * Terminos que la descripcion de la tool debe seguir anunciando. Si una
   * mutacion los elimina, la capacidad deja de resolverse: es exactamente la
   * degradacion que el meta-eval tiene que detectar.
   */
  terms: readonly string[];
}

const CAPABILITY_SPECS: Record<Capability, CapabilitySpec> = {
  "listar-servicios": { tools: ["list_services"], terms: ["inventario"] },
  "detalle-servicio": { tools: ["get_service"], terms: ["detalle de un servicio"] },
  metricas: { tools: ["query_metrics"], terms: ["serie temporal", "metrica"] },
  logs: { tools: ["search_logs"], terms: ["lineas de log"] },
  despliegues: { tools: ["get_deploys"], terms: ["despliegues"] },
  trazas: { tools: ["get_trace_summary"], terms: ["downstream"] },
  alertas: { tools: ["list_alerts"], terms: ["alertas"] },
  flags: { tools: ["get_feature_flags"], terms: ["feature flags"] },
  guardia: { tools: ["get_oncall"], terms: ["guardia"] },
  runbooks: { tools: ["search_runbooks"], terms: ["runbooks"] },
  "proponer-rollback": { tools: ["propose_rollback"], terms: ["plan de un rollback"] },
  "proponer-flag": { tools: ["propose_set_flag"], terms: ["cambio de feature flag"] },
  "proponer-silencio": {
    tools: ["propose_silence_alert"],
    terms: ["silenciar una alerta"],
  },
};

export class CatalogDegradedError extends Error {
  readonly capability: Capability;

  constructor(capability: Capability) {
    super(
      `catalogo degradado: ninguna tool anuncia la capacidad "${capability}"`,
    );
    this.name = "CatalogDegradedError";
    this.capability = capability;
  }
}

function normalize(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

/**
 * Resuelve una capacidad a una tool leyendo nombre y descripcion del catalogo.
 *
 * No hay una tabla `capacidad -> tool` que se salte el catalogo: si la descripcion
 * deja de decir que hace la tool, la resolucion falla. Asi el meta-eval prueba algo
 * real y no una constante.
 */
export function resolveCapability(
  capability: Capability,
  catalog: ToolCatalog = defaultCatalog(),
): ToolName {
  const spec = CAPABILITY_SPECS[capability];
  const byName = new Map(catalog.map((entry) => [entry.name, entry]));

  for (const name of spec.tools) {
    const entry = byName.get(name);
    if (!entry) {
      continue;
    }
    const haystack = normalize(`${entry.name} ${entry.title} ${entry.description}`);
    if (spec.terms.some((term) => haystack.includes(normalize(term)))) {
      return name;
    }
  }

  throw new CatalogDegradedError(capability);
}

export function describeCatalog(catalog: ToolCatalog = defaultCatalog()): string {
  return catalog.map((entry) => `- ${entry.name}: ${entry.description}`).join("\n");
}
