-- Counts caption checks per person, so the Claude-backed checker can be rate limited.
create table if not exists public.caption_checks (id bigserial primary key, who text not null, created_at timestamptz not null default now());
create index if not exists caption_checks_who_created_idx on public.caption_checks (who, created_at desc);
alter table public.caption_checks enable row level security;
