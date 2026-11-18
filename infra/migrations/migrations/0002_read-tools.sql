-- Tablas de dominio que consumen las tools de lectura restantes (docs/plan.md §3.1 y §7).
--
-- `incidents` no se crea todavía: solo la consumen tools de escritura (create_incident,
-- add_incident_note) que llegan en la semana 4. Su forma la dictará su contrato.
--
-- Las alertas no guardan banderas de "ruidosa" ni "falsa": eso es verdad de referencia
-- del eval, no un dato que el modelo pueda leer. Se deduce del resto del dataset.

create table logs (
  id bigint generated always as identity primary key,
  service_id bigint not null references services (id) on delete cascade,
  ts timestamptz not null,
  level text not null check (level in ('debug', 'info', 'warn', 'error')),
  message text not null,
  fields jsonb not null default '{}'::jsonb
);

create index logs_service_ts_idx on logs (service_id, ts desc);

create table deploys (
  id bigint generated always as identity primary key,
  service_id bigint not null references services (id) on delete cascade,
  version text not null,
  commit_sha text not null,
  author text not null,
  deployed_at timestamptz not null,
  diff_summary text not null,
  files_changed integer not null check (files_changed > 0),
  rollout_status text not null
    check (rollout_status in ('completed', 'in_progress', 'rolled_back', 'failed')),
  unique (service_id, version)
);

create index deploys_service_deployed_at_idx on deploys (service_id, deployed_at desc);

create table alerts (
  id bigint generated always as identity primary key,
  service_id bigint not null references services (id) on delete cascade,
  name text not null,
  severity text not null check (severity in ('page', 'ticket', 'info')),
  status text not null check (status in ('firing', 'acknowledged', 'resolved')),
  started_at timestamptz not null,
  resolved_at timestamptz,
  summary text not null,
  check ((status = 'resolved') = (resolved_at is not null))
);

create index alerts_service_started_at_idx on alerts (service_id, started_at desc);
create index alerts_status_idx on alerts (status);

create table feature_flags (
  id bigint generated always as identity primary key,
  service_id bigint not null references services (id) on delete cascade,
  key text not null unique,
  description text not null,
  enabled boolean not null,
  rollout_percent integer not null check (rollout_percent between 0 and 100),
  updated_at timestamptz not null,
  updated_by text not null
);

create table feature_flag_changes (
  id bigint generated always as identity primary key,
  flag_id bigint not null references feature_flags (id) on delete cascade,
  changed_at timestamptz not null,
  changed_by text not null,
  from_value text not null,
  to_value text not null,
  reason text not null
);

create index feature_flag_changes_flag_changed_at_idx
  on feature_flag_changes (flag_id, changed_at desc);

create table runbooks (
  id bigint generated always as identity primary key,
  -- `null` = runbook transversal (no atado a un servicio).
  service_id bigint references services (id) on delete cascade,
  slug text not null,
  title text not null,
  body_md text not null,
  updated_at timestamptz not null,
  unique nulls not distinct (service_id, slug)
);

create index runbooks_service_idx on runbooks (service_id);

create table oncall (
  id bigint generated always as identity primary key,
  service_id bigint not null unique references services (id) on delete cascade,
  rotation text not null,
  primary_name text not null,
  primary_handle text not null,
  secondary_name text not null,
  secondary_handle text not null,
  escalation_minutes integer[] not null,
  policy text not null
);
