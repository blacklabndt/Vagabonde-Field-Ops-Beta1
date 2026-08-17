insert into public.rate_overrides (job_id, basis, description, bid_ref, active, locked)
select id, 'Lump sum per weld', 'Tie-in x6 — winter spread', 'Bid NRP-2026-014', true, false from public.jobs where job_number = 'J-2843'
union all
select id, 'Bid schedule B', 'Vessel nozzles — turnaround', 'Bid ATH-TA-09', true, false from public.jobs where job_number = 'J-2844'
union all
select id, 'MSA less 10%', 'RT + MT — small diameter run', 'Verbal — R. Tessier', false, false from public.jobs where job_number = 'J-2842'
union all
select id, 'Day rate + per weld', 'Shop spools — volume batch', 'Bid BSF-Q1-03', true, false from public.jobs where job_number = 'J-2839';
