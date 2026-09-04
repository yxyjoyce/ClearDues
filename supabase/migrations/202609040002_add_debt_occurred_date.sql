alter table if exists public.debts
  add column if not exists occurred_date date;

update public.debts
set occurred_date = updated_at::date
where occurred_date is null;

alter table if exists public.debts
  alter column occurred_date set default current_date,
  alter column occurred_date set not null;
