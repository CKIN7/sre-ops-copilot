-- Escrituras en dos fases (ADR-004, docs/plan.md §3.4, §4.6 y §7).
--
-- `proposals` guarda el plan que una tool `propose_*` calculó y que un humano tiene que
-- aprobar; `approvals` guarda la decisión. La separación es deliberada: la propuesta es
-- el plan, la aprobación es el acto humano. Una propuesta sin `approvals` está
-- pendiente; con una decisión, está resuelta.
--
-- Todo lo que se persiste aquí pasa por redacción antes (no negociable 7): las columnas
-- `*_redacted` guardan el valor ya redactado, y la ejecución usa exactamente esos
-- valores. Lo crudo solo existe en memoria.
--
-- `idempotency_key` es única por tenant: repetir la misma propuesta devuelve la misma
-- fila y el mismo `approval_id` en vez de abrir una segunda discusión. Es una
-- restricción, no un `if`: la garantía sobrevive a un reinicio del proceso.

-- El audit gana las acciones de las dos fases. Se amplía el CHECK en vez de sustituir
-- la columna: las filas existentes siguen siendo válidas y no se reescribe ninguna.
alter table audit_log drop constraint audit_log_action_check;
alter table audit_log
  add constraint audit_log_action_check check (
    action in (
      'tool.call.allowed',
      'tool.call.denied',
      'tool.call.error',
      'tool.call.result',
      'proposal.created',
      'proposal.approved',
      'proposal.rejected',
      'action.applied',
      'action.denied',
      'action.replayed'
    )
  );

create table proposals (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id) on delete cascade,
  -- Qué se propone, no qué tool lo propuso: el par (kind, tool) es fijo.
  kind text not null check (kind in ('rollback', 'set_flag', 'silence_alert')),
  tool text not null check (
    tool in ('propose_rollback', 'propose_set_flag', 'propose_silence_alert')
  ),
  status text not null check (
    status in (
      'pending_approval',
      'approved',
      'rejected',
      'applied',
      'noop',
      'conflict',
      'timeout',
      'partial',
      'degraded',
      'failed'
    )
  ),
  risk text not null check (risk in ('alto', 'medio', 'bajo')),
  -- Qué se toca: el servicio, la flag o la alerta. Es lo que el humano lee de un vistazo.
  target text not null,
  args_redacted jsonb not null default '{}'::jsonb,
  diff jsonb not null default '{}'::jsonb,
  blast_radius jsonb not null default '{}'::jsonb,
  evidence jsonb not null default '[]'::jsonb,
  idempotency_key text not null,
  -- `null` = propuesta fuera de un run (un operador la abre desde la API).
  run_id uuid references runs (id) on delete set null,
  tool_call_id uuid references tool_calls (id) on delete set null,
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  applied_at timestamptz
);

create unique index proposals_tenant_idempotency_idx
  on proposals (tenant_id, idempotency_key);
create index proposals_tenant_created_idx on proposals (tenant_id, created_at desc);
create index proposals_tenant_status_idx on proposals (tenant_id, status);

-- Una decisión por propuesta: es terminal. Repetir la aprobación devuelve la existente
-- en vez de abrir un hilo de decisiones que nadie sabe cuál manda.
create table approvals (
  id uuid primary key default gen_random_uuid(),
  proposal_id uuid not null references proposals (id) on delete cascade,
  tenant_id uuid not null references tenants (id) on delete cascade,
  -- `user:<uuid>`: el id resuelto server-side, nunca un email (la PII no se persiste).
  approver text not null,
  decision text not null check (decision in ('approved', 'rejected')),
  reason text,
  decided_at timestamptz not null default now()
);

create unique index approvals_proposal_idx on approvals (proposal_id);
create index approvals_tenant_decided_idx on approvals (tenant_id, decided_at desc);
