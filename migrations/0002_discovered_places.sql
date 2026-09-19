create table if not exists discovered_places (
  id text primary key,
  canonical_key text not null unique,
  canonical_name text not null,
  normalized_name text not null,
  region text not null,
  country text not null default '中国',
  place_type text not null,
  summary text not null,
  tags jsonb not null default '[]'::jsonb,
  source_snapshot jsonb not null default '[]'::jsonb,
  confidence numeric(4,3) not null check (confidence >= 0 and confidence <= 1),
  status text not null check (status in ('verified', 'candidate')),
  art text not null,
  accent text not null,
  visual_seed integer not null unique,
  route_context jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_verified_at timestamptz not null default now(),
  usage_count integer not null default 0
);
create index if not exists discovered_places_normalized_name_idx on discovered_places (normalized_name);
create index if not exists discovered_places_status_updated_idx on discovered_places (status, updated_at desc);