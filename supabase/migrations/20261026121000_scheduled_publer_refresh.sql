-- Refresh Publer's numbers regularly, so there is a view count per post every day even when nobody opens the
-- portal. Asked every hour; the portal's "refresh-stats" action does nothing if the numbers are under 3 hours old.
create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron;
select cron.schedule(
  'portal-refresh-stats',
  '7 * * * *',
  $$select net.http_post(
      url := 'https://pcqghtwfedjokbzrcrlm.supabase.co/functions/v1/portal',
      body := '{"action":"refresh-stats"}'::jsonb,
      headers := '{"Content-Type":"application/json"}'::jsonb,
      timeout_milliseconds := 120000
    );$$
);
