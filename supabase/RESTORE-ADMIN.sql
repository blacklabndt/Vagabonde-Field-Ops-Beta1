-- =====================================================================
-- RESTORE AN ADMIN THAT WAS LOCKED OUT
-- Supabase -> SQL Editor -> New query -> paste -> Run
--
-- Changing your own role in Users and access used to strip your own admin
-- tabs. Once the row loses the users tab, every policy gated on
-- has_tab('users') denies you, so the app cannot put it back -- it has to
-- be done here.
--
-- Replace the address below with the account to restore, then run.
-- =====================================================================

update public.profiles p
set role = 'Admin',
    tab_access = public.tabs_for_role('Admin')
from auth.users u
where u.id = p.id
  and lower(u.email) = lower('you@example.com');   -- <- your email here


-- Check it took: this should list the account as Admin with the full
-- Admin tab set (whatever tabs_for_role('Admin') grants — 14 at present).
select u.email, p.name, p.role, cardinality(p.tab_access) as tabs
from public.profiles p
join auth.users u on u.id = p.id
order by p.role, p.name;
