-- Email list tracker: fans carried over from DMs before the ManyChat connection went live (the one-off run on
-- 26 Oct 2026) count in the total but not as new sign-ups.
alter table public.fans add column if not exists carried_over boolean not null default false;

update public.fans
set carried_over = true
where created_at >= '2026-10-26 16:41:00+00' and created_at < '2026-10-26 16:49:00+00';
