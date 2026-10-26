-- Team area: a copy of Publer's post numbers, refreshed by the portal function (service role only).
create table if not exists public.publer_posts (
  id text primary key,
  account_id text,
  network text,
  published_at timestamptz,
  text text,
  link text,
  views integer,
  reach integer,
  likes integer,
  comments integer,
  shares integer,
  saves integer,
  raw jsonb,
  fetched_at timestamptz not null default now()
);
create index if not exists publer_posts_network_time on public.publer_posts (network, published_at desc);

-- Small key/value store for the portal function (Publer workspace and accounts, last refresh time).
create table if not exists public.app_state (
  key text primary key,
  value jsonb,
  updated_at timestamptz not null default now()
);

alter table public.publer_posts enable row level security;
alter table public.app_state enable row level security;
revoke all on public.publer_posts from anon, authenticated;
revoke all on public.app_state from anon, authenticated;
