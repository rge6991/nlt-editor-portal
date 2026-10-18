-- A session can belong to an editor, a reviewer, or someone who is both.
alter table public.sessions add column if not exists reviewer_id text;
alter table public.sessions alter column editor_id drop not null;
alter table public.sessions add constraint sessions_has_role check (editor_id is not null or reviewer_id is not null);
