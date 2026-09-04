create table if not exists public.debts (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  person text not null check (char_length(trim(person)) between 1 and 120),
  direction text not null check (direction in ('owe', 'owed')),
  initial_amount_cents bigint not null check (initial_amount_cents > 0),
  due_date date,
  notes text not null default '',
  deleted_at timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists public.repayments (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  debt_id uuid not null references public.debts(id) on delete cascade,
  amount_cents bigint not null check (amount_cents > 0),
  date date not null,
  notes text not null default '',
  deleted_at timestamptz,
  updated_at timestamptz not null default now()
);

create index if not exists debts_user_id_idx on public.debts(user_id);
create index if not exists repayments_user_id_idx on public.repayments(user_id);
create index if not exists repayments_debt_id_idx on public.repayments(debt_id);

alter table public.debts enable row level security;
alter table public.repayments enable row level security;

revoke all on table public.debts, public.repayments from anon;
grant select, insert, update, delete on table public.debts, public.repayments to authenticated;

drop policy if exists "Users can view their own debts" on public.debts;
create policy "Users can view their own debts" on public.debts for select to authenticated using ((select auth.uid()) = user_id);
drop policy if exists "Users can create their own debts" on public.debts;
create policy "Users can create their own debts" on public.debts for insert to authenticated with check ((select auth.uid()) = user_id);
drop policy if exists "Users can update their own debts" on public.debts;
create policy "Users can update their own debts" on public.debts for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
drop policy if exists "Users can delete their own debts" on public.debts;
create policy "Users can delete their own debts" on public.debts for delete to authenticated using ((select auth.uid()) = user_id);

drop policy if exists "Users can view their own repayments" on public.repayments;
create policy "Users can view their own repayments" on public.repayments for select to authenticated using ((select auth.uid()) = user_id);
drop policy if exists "Users can create their own repayments" on public.repayments;
create policy "Users can create their own repayments" on public.repayments for insert to authenticated with check ((select auth.uid()) = user_id);
drop policy if exists "Users can update their own repayments" on public.repayments;
create policy "Users can update their own repayments" on public.repayments for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
drop policy if exists "Users can delete their own repayments" on public.repayments;
create policy "Users can delete their own repayments" on public.repayments for delete to authenticated using ((select auth.uid()) = user_id);
