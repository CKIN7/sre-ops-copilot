-- Demo publica: sesion anonima, techo diario y circuit breaker (docs/plan.md §4.11,
-- §12 y §14; ADR-015).
--
-- La demo no usa un contador en memoria: el estado de la sesion vive en Postgres y
-- se cobra/actualiza en una transaccion con lock. La IP se guarda hasheada; no se
-- persiste ningun dato personal.

alter table rate_limit_events add column session_id text;
alter table rate_limit_events add column ip_hash text;

create index rate_limit_events_session_idx
  on rate_limit_events (session_id, created_at desc);
create index rate_limit_events_ip_idx
  on rate_limit_events (ip_hash, created_at desc);

-- Una fila por sesion anonima. `spent_cents` y `steps` son el presupuesto de la
-- sesion; se incrementan atomicamente bajo `pg_advisory_xact_lock`.
create table demo_sessions (
  session_id text primary key,
  ip_hash text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  spent_cents integer not null default 0 check (spent_cents >= 0),
  steps integer not null default 0 check (steps >= 0)
);

create index demo_sessions_created_idx on demo_sessions (created_at desc);
create index demo_sessions_expiry_idx on demo_sessions (expires_at);

-- Singleton del circuit breaker. Si `replay_only` esta a true, la demo solo sirve
-- fixtures y no llama a mcp-ops. Los fallos se cuentan para dispararlo solo.
create table demo_breaker (
  singleton boolean primary key default true check (singleton),
  replay_only boolean not null default false,
  failures integer not null default 0 check (failures >= 0),
  updated_at timestamptz not null default now()
);

insert into demo_breaker (singleton) values (true) on conflict (singleton) do nothing;
