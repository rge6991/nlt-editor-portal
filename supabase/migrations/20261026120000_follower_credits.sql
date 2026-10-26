-- Views per post per day (latest count of the day, Vienna), so new followers can be credited to the posts
-- that got the views that day. And hand-set credits for days before those snapshots existed.
create table if not exists public.publer_post_days (
  post_id text not null,
  account_id text not null,
  network text not null,
  day date not null,
  views integer,
  reach integer,
  fetched_at timestamptz not null default now(),
  primary key (post_id, day)
);
create index if not exists publer_post_days_account_day on public.publer_post_days (account_id, day);
alter table public.publer_post_days enable row level security;
revoke all on public.publer_post_days from anon, authenticated;

create table if not exists public.follower_credits (
  account_id text not null,
  day date not null,
  post_id text not null,
  note text,
  primary key (account_id, day, post_id)
);
alter table public.follower_credits enable row level security;
revoke all on public.follower_credits from anon, authenticated;

-- 19 Oct: Facebook pushed the 11 Oct reel "Some things make sense only after you experience them."
-- (56,632 page video views that day; no other Facebook post has more than 4,000 views in total).
-- Facebook's follower count jumped by 1,047 on 20 Oct.
insert into public.follower_credits (account_id, day, post_id, note)
values ('6ad2309ccfb984ff9e90af77', '2026-10-20', '222059832',
        'Facebook pushed the 11 Oct reel on 19 Oct: 56,632 page video views that day, +1,047 followers the next day.')
on conflict do nothing;
