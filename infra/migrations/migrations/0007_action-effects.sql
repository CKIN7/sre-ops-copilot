-- Efectos de las escrituras (ADR-004 decisión 5, ADR-005, docs/plan.md §6.3 y §7).
--
-- `action_effects` es el registro de lo que pasó cuando se ejecutó una escritura
-- aprobada. La fila se **reserva antes** de llamar al ejecutor: si la clave de
-- idempotencia ya existe, el `apply` devuelve el efecto guardado y no vuelve a
-- ejecutar. La unicidad de `idempotency_key` es la garantía, no una comprobación en
-- código, así que sobrevive a un reinicio y a dos réplicas a la vez.
--
-- `verified` es lo que separa "se aplicó" de "se aplicó y no lo comprobamos". Con
-- `verified=false` la propuesta queda `degraded`: nunca se reporta como éxito.

create table action_effects (
  id uuid primary key default gen_random_uuid(),
  proposal_id uuid not null references proposals (id) on delete cascade,
  tenant_id uuid not null references tenants (id) on delete cascade,
  tool_call_id uuid references tool_calls (id) on delete set null,
  idempotency_key text not null,
  executor text not null,
  -- Estable por `idempotency_key`: lo deriva de la clave, no de un UUID aleatorio.
  effect_id text not null,
  status text not null check (
    status in ('pending', 'applied', 'noop', 'conflict', 'timeout', 'partial', 'failed')
  ),
  verified boolean not null default false,
  observed_state jsonb,
  evidence jsonb not null default '[]'::jsonb,
  duration_ms integer not null default 0 check (duration_ms >= 0),
  error_code text,
  created_at timestamptz not null default now(),
  applied_at timestamptz
);

create unique index action_effects_idempotency_idx on action_effects (idempotency_key);
create index action_effects_proposal_idx on action_effects (proposal_id);
create index action_effects_tenant_created_idx on action_effects (tenant_id, created_at desc);

-- Estado simulado del mundo: el documento versionado que el `SimulatedExecutor` muta.
--
-- Es el "efecto" que la tabla de honestidad del plan (§11.7) promete para la demo
-- pública: no una llamada real, sino un estado real en Postgres que se puede leer y
-- verificar. La versión es lo que permite el compare-and-swap y, con él, el `409`.
create table simulated_state (
  target text primary key,
  state jsonb not null default '{}'::jsonb,
  version integer not null default 1 check (version > 0),
  updated_at timestamptz not null default now()
);
