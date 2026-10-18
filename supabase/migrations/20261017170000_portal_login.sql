-- Login codes and sessions for the NLT editor portal.
-- Only the edge functions (service role) touch these tables; RLS with no policies blocks everyone else.

create table if not exists public.login_codes (
  id bigserial primary key,
  email text not null,
  code_hash text not null,
  attempts int not null default 0,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index if not exists login_codes_email_created_idx on public.login_codes (email, created_at desc);

create table if not exists public.sessions (
  token_hash text primary key,
  editor_id text not null,
  email text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index if not exists sessions_expires_idx on public.sessions (expires_at);

alter table public.login_codes enable row level security;
alter table public.sessions enable row level security;
