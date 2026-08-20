-- pg_trgm moves out of the public schema, the last of the advisor's
-- extension warnings. Unlike pg_net this one has dependents: the seven
-- trigram GIN indexes that make the directory and job searches fast.
-- Nothing else touches the extension — the search functions use plain
-- ILIKE, which these indexes accelerate without being named in any
-- query — so the whole move is drop indexes, move extension, rebuild
-- indexes against the relocated operator class. One transaction: the
-- searches never see a half-moved state, they just run unindexed for
-- the seconds this takes.

drop index public.idx_clients_name_trgm;
drop index public.idx_contacts_name_trgm;
drop index public.idx_contacts_email_trgm;
drop index public.idx_contractors_name_trgm;
drop index public.idx_jobs_project_trgm;
drop index public.idx_jobs_search_text_trgm;
drop index public.idx_jobs_lsd_trgm;

drop extension pg_trgm;
create extension pg_trgm schema extensions;

-- The same seven, spelled with the operator class's new home.
create index idx_clients_name_trgm on public.clients using gin (name extensions.gin_trgm_ops);
create index idx_contacts_name_trgm on public.contacts using gin (name extensions.gin_trgm_ops);
create index idx_contacts_email_trgm on public.contacts using gin (email extensions.gin_trgm_ops);
create index idx_contractors_name_trgm on public.contractors using gin (name extensions.gin_trgm_ops);
create index idx_jobs_project_trgm on public.jobs using gin (project extensions.gin_trgm_ops);
create index idx_jobs_search_text_trgm on public.jobs using gin (search_text extensions.gin_trgm_ops);
create index idx_jobs_lsd_trgm on public.jobs using gin (lsd extensions.gin_trgm_ops);
