-- Reverts the id_code split from 20260814100000.
--
-- That migration moved `id_code` into a private table on the reasoning that it
-- held a driver's licence number — which is what the field's own placeholder
-- says. In practice it holds a CEDO/CGSB certification number: a professional
-- credential, not personal identification.
--
-- That inverts the requirement. A certification number is not something to
-- hide from colleagues; it is something the assessment has to carry. The JHA
-- PDF prints it for *both* nuclear energy workers, so restricting reads left
-- the helper's column blank on a regulatory document — a worse outcome than
-- the exposure it was guarding against.
--
-- Putting it back on `profiles` gives the posture this actually wants, with no
-- extra table:
--
--   read   — any staff account, which is what the JHA prefill and the printed
--            form need.
--   write  — admins only, already enforced by the profiles_update policy,
--            which requires the `users` tab. A technician cannot alter anyone's
--            certification record, including their own.

alter table public.profiles add column if not exists id_code text;

-- Anything written while the column was gone comes back with it.
update public.profiles p
set id_code = pp.id_code
from public.profile_private pp
where pp.profile_id = p.id
  and pp.id_code is not null
  and p.id_code is distinct from pp.id_code;

drop table if exists public.profile_private;
