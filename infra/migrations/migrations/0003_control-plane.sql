-- Control plane mínimo para M2 (docs/plan.md §7): identidad, agentes, runs, steps y
-- tool calls. Las tablas de aprobaciones, efectos, presupuesto y audit llegan con sus
-- hitos (M3/M4); no se crean vacías para no fijar una forma que aún no tiene contrato.
--
-- Las fechas de negocio (`started_at`, `ended_at`, `finished_at`) son nullable porque el
-- run y la tool call se escriben antes de ejecutarse (write-ahead, §5).

create table tenants (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  created_at timestamptz not null default now()
);

create table users (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id) on delete cascade,
  email text not null,
  display_name text not null,
  created_at timestamptz not null default now(),
  unique (tenant_id, email)
);

create table agents (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id) on delete cascade,
  name text not null,
  model text not null,
  prompt_version text not null,
  allowed_tools text[] not null default '{}'::text[],
  budget_cents integer not null default 0 check (budget_cents >= 0),
  created_at timestamptz not null default now(),
  unique (tenant_id, name)
);

create table runs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id) on delete cascade,
  agent_id uuid not null references agents (id),
  status text not null check (
    status in ('queued', 'running', 'waiting_approval', 'succeeded', 'failed', 'cancelled', 'degraded')
  ),
  trigger text not null check (trigger in ('cli', 'api', 'ui', 'schedule')),
  goal text not null,
  started_at timestamptz,
  ended_at timestamptz,
  cost_cents integer not null default 0 check (cost_cents >= 0),
  tokens_in integer not null default 0 check (tokens_in >= 0),
  tokens_out integer not null default 0 check (tokens_out >= 0),
  error_code text,
  created_at timestamptz not null default now(),
  check ((status in ('succeeded', 'failed', 'cancelled', 'degraded')) = (ended_at is not null))
);

create index runs_tenant_started_at_idx on runs (tenant_id, started_at desc);

create table steps (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references runs (id) on delete cascade,
  idx integer not null check (idx >= 0),
  kind text not null check (kind in ('model', 'tool')),
  model text,
  prompt_version text,
  latency_ms integer not null default 0 check (latency_ms >= 0),
  cost_cents integer not null default 0 check (cost_cents >= 0),
  payload_ref text,
  created_at timestamptz not null default now(),
  unique (run_id, idx)
);

create table tool_calls (
  id uuid primary key default gen_random_uuid(),
  step_id uuid not null references steps (id) on delete cascade,
  tool text not null,
  args_redacted jsonb not null default '{}'::jsonb,
  result_hash text,
  status text not null check (status in ('pending', 'ok', 'error')),
  error_code text,
  idempotency_key text,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);

create index tool_calls_step_idx on tool_calls (step_id);
