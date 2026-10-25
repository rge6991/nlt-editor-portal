-- Rate limits and login-code checks that must hold under parallel requests.
-- Only the portal and jobs functions (service role) call these.

create table if not exists public.rate_hits (
  id bigserial primary key,
  key text not null,
  created_at timestamptz not null default now()
);
create index if not exists rate_hits_key_created_idx on public.rate_hits (key, created_at desc);
create index if not exists rate_hits_created_idx on public.rate_hits (created_at);
alter table public.rate_hits enable row level security;
revoke all on table public.rate_hits from anon, authenticated;
revoke all on sequence public.rate_hits_id_seq from anon, authenticated;

-- Counts one hit for a key (an IP, a person, or "global:...") and says whether it is still
-- within p_max per p_window. Serialised per key, so parallel calls can't slip past the limit.
create or replace function public.rate_hit(p_key text, p_window interval, p_max int)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare n int;
begin
  perform pg_advisory_xact_lock(hashtextextended('rate:' || p_key, 0));
  if random() < 0.02 then
    delete from rate_hits where created_at < now() - interval '2 days';
  end if;
  select count(*) into n from rate_hits where key = p_key and created_at > now() - p_window;
  if n >= p_max then
    return false;
  end if;
  insert into rate_hits (key) values (p_key);
  return true;
end;
$$;

-- Stores a new login code unless this email already got 5 in the last hour or 10 in the last day.
create or replace function public.issue_login_code(p_email text, p_hash text, p_expires timestamptz)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare last_hour int; last_day int;
begin
  perform pg_advisory_xact_lock(hashtextextended('code:' || p_email, 0));
  select count(*) filter (where created_at > now() - interval '1 hour'), count(*)
    into last_hour, last_day
    from login_codes
    where email = p_email and created_at > now() - interval '1 day';
  if last_hour >= 5 or last_day >= 10 then
    return false;
  end if;
  insert into login_codes (email, code_hash, expires_at) values (p_email, p_hash, p_expires);
  return true;
end;
$$;

-- One guess at the latest code for an email. The attempt is counted before the code is compared,
-- in one atomic update, so parallel guesses can never get more than 5 tries per code.
-- Returns no row when the code is missing, expired or out of tries.
create or replace function public.try_login_code(p_email text)
returns table (code_id bigint, code_hash text)
language sql
security definer
set search_path = public
as $$
  update login_codes c
     set attempts = c.attempts + 1
   where c.id = (select l.id from login_codes l where l.email = p_email order by l.created_at desc limit 1)
     and c.attempts < 5
     and c.expires_at > now()
  returning c.id, c.code_hash;
$$;

revoke all on function public.rate_hit(text, interval, int) from public, anon, authenticated;
revoke all on function public.issue_login_code(text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.try_login_code(text) from public, anon, authenticated;
grant execute on function public.rate_hit(text, interval, int) to service_role;
grant execute on function public.issue_login_code(text, text, timestamptz) to service_role;
grant execute on function public.try_login_code(text) to service_role;
