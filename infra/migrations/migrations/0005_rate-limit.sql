-- Estado del rate limit con ventana deslizante (docs/plan.md §4.4, ADR-012).
--
-- Una fila por tool call aceptada. El límite se evalúa contando las filas de la
-- ventana; no hay contadores que reiniciar, así que el límite reparte entre réplicas
-- y sobrevive a un reinicio. Una llamada denegada no escribe fila: no consume
-- presupuesto.
--
-- `created_at` lo pone la base (`now()`): el contador no depende del reloj de la
-- aplicación ni de la zona horaria del cliente.

create table rate_limit_events (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references tenants (id) on delete cascade,
  run_id uuid references runs (id) on delete cascade,
  tool text not null,
  created_at timestamptz not null default now()
);

create index rate_limit_events_tenant_tool_idx
  on rate_limit_events (tenant_id, tool, created_at desc);
create index rate_limit_events_run_idx
  on rate_limit_events (run_id, created_at desc);
