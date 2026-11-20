-- Audit append-only con hash chain (docs/plan.md §4.8, ADR-012).
--
-- Cada fila guarda tres huellas: `payload_hash` (SHA-256 del payload canónico y ya
-- redactado), `prev_hash` (hash de la fila anterior) y `hash` (SHA-256 de la fila
-- completa, incluido `prev_hash`). Alterar una fila rompe su propio hash; insertar o
-- borrar una fila rompe el enlace con la siguiente. La verificación recalcula la cadena
-- entera y dice dónde deja de cuadrar.
--
-- El payload no se persiste, solo su hash: un email, una IP o un token no llegan nunca
-- a esta tabla, ni cifrados.
--
-- `created_at` no lleva `default now()` a propósito: el hash cubre la marca de tiempo y
-- tiene que ser la misma que se leyó al escribir. La fija la aplicación.

-- `tenant_id` con `on delete cascade`: borrar un tenant borra su audit, y la cadena lo
-- detecta como un hueco (el `prev_hash` de la fila siguiente deja de enlazar). Es
-- preferible a `restrict`: el borrado explícito de un tenant es una acción de
-- administración, y queda detectada; con `restrict` el tenant quedaría indeletable.
create table audit_log (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references tenants (id) on delete cascade,
  actor text not null,
  action text not null check (
    action in ('tool.call.allowed', 'tool.call.denied', 'tool.call.error', 'tool.call.result')
  ),
  target text not null,
  payload_hash text not null,
  prev_hash text not null,
  hash text not null,
  created_at timestamptz not null
);

create index audit_log_tenant_id_idx on audit_log (tenant_id, id);
create unique index audit_log_hash_idx on audit_log (hash);

-- Append-only real: la base no deja reescribir ni borrar historia. La detección por
-- hash chain sigue siendo necesaria porque un atacante con acceso al esquema puede
-- quitar el trigger; con las dos capas, quitar el trigger no basta para alterar el
-- registro sin romper la cadena.
create function audit_log_append_only() returns trigger
language plpgsql as $$
begin
  raise exception 'audit_log es append-only: % no permitido', tg_op
    using errcode = 'restrict_violation';
end;
$$;

create trigger audit_log_no_update
  before update or delete on audit_log
  for each row execute function audit_log_append_only();
