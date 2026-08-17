-- One directory entry per client/contractor, so "picking a client fills
-- their rep's details" and "the second job is mostly pre-filled" (handoff,
-- New job dialog) has something stable to upsert against.
alter table public.contacts add constraint contacts_org_unique unique (org_type, org_id);
