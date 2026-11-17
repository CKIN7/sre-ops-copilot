-- Esquema de dominio sembrado (docs/plan.md §1 y §7).
--
-- Este scaffold crea las tablas que consumen las dos tools del spike. Las tablas de
-- logs, deploys, alertas, flags, runbooks, oncall e incidentes llegan con las tools que
-- las consumen, para que su forma la dicte el contrato de cada tool y no una suposición.
--
-- `service_deps.depends_on_slug` no lleva FK: el grafo de docs/plan.md §1 incluye
-- sistemas externos (catalog, auth, psp-mock, db-primary) que no son servicios sembrados.

create table services (
  id bigint generated always as identity primary key,
  slug text not null unique,
  display_name text not null,
  role text not null,
  tier text not null check (tier in ('critical', 'standard', 'internal')),
  owner_team text not null,
  slo jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table service_deps (
  service_id bigint not null references services (id) on delete cascade,
  depends_on_slug text not null,
  kind text not null default 'sync' check (kind in ('sync', 'async')),
  primary key (service_id, depends_on_slug)
);

create table metrics_series (
  service_id bigint not null references services (id) on delete cascade,
  metric text not null,
  ts timestamptz not null,
  value double precision not null,
  -- La PK es el índice de la consulta real: servicio + metrica + rango de tiempo.
  primary key (service_id, metric, ts)
);
