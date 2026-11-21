-- Presupuesto por run/tenant con reserva atomica y liquidacion (docs/plan.md §4.5,
-- §7 y §10; ADR-013).
--
-- `budget_reservations` es el estado vivo del presupuesto. La fila se escribe ANTES
-- de llamar a la tool con una estimacion; despues se liquida con el uso observado.
-- La suma de reservas vivas y liquidadas es lo que se compara con los limites, dentro
-- de una transaccion con lock por tenant. Sin el lock, dos procesos concurrentes
-- podrian leer el mismo total y pasar los dos el mismo limite.
--
-- `idempotency_key` es unica por tenant: repetir la misma reserva devuelve la fila
-- existente y no suma dos veces. La garantia es la restriccion, no un `if`.
--
-- Una reserva viva tiene `expires_at`. Si el proceso muere entre reservar y liquidar,
-- la siguiente reserva del tenant la cierra como liquidada con uso cero; no queda una
-- reserva huerfana consumiendo presupuesto para siempre.

create table budget_reservations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id) on delete cascade,
  run_id uuid references runs (id) on delete cascade,
  idempotency_key text not null,
  status text not null check (status in ('reserved', 'settled')),
  -- Estimacion reservada antes de la llamada.
  reserved_tokens_in integer not null default 0 check (reserved_tokens_in >= 0),
  reserved_tokens_out integer not null default 0 check (reserved_tokens_out >= 0),
  reserved_cost_cents integer not null default 0 check (reserved_cost_cents >= 0),
  reserved_wall_ms integer not null default 0 check (reserved_wall_ms >= 0),
  -- Uso observado al liquidar; `null` mientras la reserva sigue viva.
  used_tokens_in integer check (used_tokens_in is null or used_tokens_in >= 0),
  used_tokens_out integer check (used_tokens_out is null or used_tokens_out >= 0),
  used_cost_cents integer check (used_cost_cents is null or used_cost_cents >= 0),
  used_wall_ms integer check (used_wall_ms is null or used_wall_ms >= 0),
  -- Limites aplicados, para que la fila explique por que se permitio o no.
  limits jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  settled_at timestamptz,
  check ((status = 'settled') = (settled_at is not null)),
  check (
    (status = 'settled') = (used_tokens_in is not null and used_tokens_out is not null
      and used_cost_cents is not null and used_wall_ms is not null)
  )
);

create unique index budget_reservations_tenant_key_idx
  on budget_reservations (tenant_id, idempotency_key);
create index budget_reservations_tenant_status_idx
  on budget_reservations (tenant_id, status, created_at desc);
create index budget_reservations_run_status_idx
  on budget_reservations (run_id, status, created_at desc);
create index budget_reservations_expiry_idx
  on budget_reservations (status, expires_at);

-- `usage_ledger` es append-only: una fila por liquidacion. No sustituye a las
-- reservas (que se actualizan al liquidar), sino que deja el rastro contable que se
-- puede sumar sin releer el estado vivo. `kind` distingue el origen del uso.
create table usage_ledger (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references tenants (id) on delete cascade,
  run_id uuid references runs (id) on delete cascade,
  reservation_id uuid not null references budget_reservations (id) on delete cascade,
  kind text not null check (kind in ('tool_call', 'model', 'action_apply')),
  tool text,
  tokens_in integer not null default 0 check (tokens_in >= 0),
  tokens_out integer not null default 0 check (tokens_out >= 0),
  cost_cents integer not null default 0 check (cost_cents >= 0),
  wall_ms integer not null default 0 check (wall_ms >= 0),
  created_at timestamptz not null default now()
);

-- Una liquidacion por reserva: la idempotencia tambien queda en la base.
create unique index usage_ledger_reservation_idx on usage_ledger (reservation_id);
create index usage_ledger_tenant_created_idx on usage_ledger (tenant_id, created_at desc);
create index usage_ledger_run_created_idx on usage_ledger (run_id, created_at desc);

create or replace function usage_ledger_append_only() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' and pg_trigger_depth() > 1 then
    return old;
  end if;

  raise exception 'usage_ledger es append-only: % no permitido', tg_op
    using errcode = 'restrict_violation';
end;
$$;

create trigger usage_ledger_no_update
  before update or delete on usage_ledger
  for each row execute function usage_ledger_append_only();
