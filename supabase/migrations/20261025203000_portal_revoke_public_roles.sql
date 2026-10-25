-- Only the portal and jobs functions (service role) ever touch these tables.
-- RLS already denies everything to the public roles; this removes the table grants too, as a second lock.
revoke all on table public.sessions, public.login_codes, public.caption_checks from anon, authenticated;
revoke all on sequence public.caption_checks_id_seq, public.login_codes_id_seq from anon, authenticated;
