-- Followers per social account per day, from Publer's "followers" chart. Read only by the portal function.
create table if not exists public.follower_counts (
  account_id text not null,
  network text not null,
  day date not null,
  followers integer not null,
  fetched_at timestamptz not null default now(),
  primary key (account_id, day)
);
create index if not exists follower_counts_network_day on public.follower_counts (network, day);
alter table public.follower_counts enable row level security;
revoke all on public.follower_counts from anon, authenticated;
