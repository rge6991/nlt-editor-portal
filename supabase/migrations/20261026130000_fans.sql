-- NLT's email list: fans who left their email in a ManyChat conversation (Instagram DMs).
-- Filled only by the manychat function, which reads each contact back from ManyChat's API.
create table if not exists public.fans (
  email text primary key,
  manychat_id text,
  first_name text,
  last_name text,
  ig_username text,
  optin_email boolean not null default false,
  source text not null default 'manychat',
  tags text[] not null default '{}',
  mailchimp_status text,
  mailchimp_synced_at timestamptz,
  mailchimp_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists fans_manychat_id on public.fans (manychat_id);
create index if not exists fans_created_at on public.fans (created_at desc);
alter table public.fans enable row level security;
revoke all on public.fans from anon, authenticated;
