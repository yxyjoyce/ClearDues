alter table if exists public.debts
  add column if not exists annual_interest_rate_bps integer null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.debts'::regclass
      and conname = 'debts_annual_interest_rate_bps_check'
  ) then
    alter table public.debts
      add constraint debts_annual_interest_rate_bps_check
      check (annual_interest_rate_bps is null or annual_interest_rate_bps > 0);
  end if;
end $$;
