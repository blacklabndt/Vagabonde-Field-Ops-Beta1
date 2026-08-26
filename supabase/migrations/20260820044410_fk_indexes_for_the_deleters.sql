-- The performance advisor's three unindexed foreign keys, all pointing
-- at profiles. They matter for one operation: deleting an account from
-- Users & access, which makes Postgres hunt each referencing table for
-- rows to cascade or null out — a sequential scan per table without
-- these. Chat made two of them (messages cascade, pins go null) and the
-- arcade made the third, longer ago.

create index chat_messages_by_profile on public.chat_messages (profile_id);

-- Partial: pins are a handful of rows at most, and the FK lookup always
-- carries a concrete id, which implies "is not null" — so the index
-- stays a few kilobytes instead of shadowing the whole table.
create index chat_messages_by_pinner on public.chat_messages (pinned_by)
  where pinned_by is not null;

create index arcade_scores_by_profile on public.arcade_scores (profile_id);
