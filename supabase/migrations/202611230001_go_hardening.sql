-- GO / MITRA RUN production hardening migration
-- Apply once in Supabase SQL Editor after reviewing the project schema.

-- Effective-dated driver route tariff. The app snapshots the active rate onto each order at assignment.
create table if not exists public.driver_freight_rates (
  id uuid primary key default gen_random_uuid(),
  amount_toman bigint not null check (amount_toman >= 0),
  effective_from timestamptz not null,
  created_by uuid references auth.users(id) default auth.uid(),
  created_at timestamptz not null default now()
);
create index if not exists driver_freight_rates_effective_idx
  on public.driver_freight_rates (effective_from desc);

alter table public.orders
  add column if not exists driver_freight_toman bigint not null default 0
  check (driver_freight_toman >= 0);

alter table public.driver_freight_rates enable row level security;
grant select, insert on public.driver_freight_rates to authenticated;

drop policy if exists go_seller_read_driver_freight_rates on public.driver_freight_rates;
create policy go_seller_read_driver_freight_rates
on public.driver_freight_rates for select to authenticated
using (exists (
  select 1 from public.profiles p
  where p.id = auth.uid() and p.role::text = 'seller' and p.is_active = true
));

drop policy if exists go_seller_insert_driver_freight_rates on public.driver_freight_rates;
create policy go_seller_insert_driver_freight_rates
on public.driver_freight_rates for insert to authenticated
with check (exists (
  select 1 from public.profiles p
  where p.id = auth.uid() and p.role::text = 'seller' and p.is_active = true
));

-- Allow assigned drivers to attach check photos; RLS still limits rows to their own missions.
alter table public.check_photos enable row level security;
grant select, insert on public.check_photos to authenticated;

drop policy if exists go_driver_insert_check_photos on public.check_photos;
create policy go_driver_insert_check_photos
on public.check_photos for insert to authenticated
with check (exists (
  select 1
  from public.customer_checks cc
  join public.missions m on m.order_id = cc.order_id
  where cc.id = check_photos.check_id
    and m.driver_id = auth.uid()
));

drop policy if exists go_driver_seller_read_check_photos on public.check_photos;
create policy go_driver_seller_read_check_photos
on public.check_photos for select to authenticated
using (
  exists (
    select 1
    from public.customer_checks cc
    join public.missions m on m.order_id = cc.order_id
    where cc.id = check_photos.check_id and m.driver_id = auth.uid()
  )
  or exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.role::text = 'seller' and p.is_active = true
  )
);

-- Once a driver uploads a check image, move the check into the seller review queue.
create or replace function public.go_queue_check_for_seller_review()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.customer_checks
  set status = 'awaiting_seller'
  where id = new.check_id and status::text = 'awaiting_driver';
  return new;
end;
$$;

drop trigger if exists go_check_photo_queue_review on public.check_photos;
create trigger go_check_photo_queue_review
after insert on public.check_photos
for each row execute function public.go_queue_check_for_seller_review();

-- Enforce settlement/check requirements at database level, not only in the browser.
create or replace function public.go_guard_mission_completion()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.status::text = 'delivered' and old.status::text is distinct from 'delivered' then
    if exists (
      select 1 from public.orders o
      where o.id = new.order_id and coalesce(o.customer_cash_balance_toman, 0) > 0
    ) then
      raise exception 'ابتدا مانده نقدی مشتری باید تسویه شود.';
    end if;

    if exists (
      select 1 from public.cash_collections c
      where c.order_id = new.order_id and c.status::text in ('pending','awaiting_driver')
    ) then
      raise exception 'دریافت وجه نقد مشتری هنوز تأیید نشده است.';
    end if;

    if exists (
      select 1
      from public.customer_checks cc
      where cc.order_id = new.order_id
        and (
          cc.status::text <> 'approved'
          or not exists (
            select 1 from public.check_photos cp
            where cp.check_id = cc.id
              and cp.deleted_at is null
              and (cp.expires_at is null or cp.expires_at > now())
          )
        )
    ) then
      raise exception 'همه چک‌ها باید تصویر معتبر داشته باشند و توسط فروشنده تأیید شوند.';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists go_guard_mission_completion_trigger on public.missions;
create trigger go_guard_mission_completion_trigger
before update of status on public.missions
for each row execute function public.go_guard_mission_completion();

-- Credit the driver's configured route fee exactly once when the mission is completed.
-- Existing uncollected customer freight remains a separate ledger event.
create or replace function public.go_credit_driver_route_fee()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_fee bigint;
begin
  if new.status::text = 'delivered' and old.status::text is distinct from 'delivered' then
    select coalesce(o.driver_freight_toman, 0)
      into v_fee
    from public.orders o
    where o.id = new.order_id;

    if coalesce(v_fee, 0) > 0 and not exists (
      select 1 from public.driver_ledger dl
      where dl.mission_id = new.id
        and dl.entry_type::text = 'adjustment'
        and dl.description like 'GO_MISSION_FREIGHT:%'
    ) then
      insert into public.driver_ledger
        (driver_id, entry_type, amount_toman, mission_id, order_id, description, created_by)
      values
        (new.driver_id, 'adjustment', v_fee, new.id, new.order_id,
         'GO_MISSION_FREIGHT: کرایه راننده برای مأموریت تکمیل‌شده', new.driver_id);
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists go_credit_driver_route_fee_trigger on public.missions;
create trigger go_credit_driver_route_fee_trigger
after update of status on public.missions
for each row execute function public.go_credit_driver_route_fee();


-- Safer one-tap loading/delivery RPC: avoids ambiguous quantity payloads from mobile forms.
create or replace function public.driver_mark_mission_item_stage(
  p_mission_item_id uuid,
  p_stage text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_ordered integer;
  v_loaded integer;
  v_status text;
begin
  if not exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.role::text = 'driver' and p.is_active = true
  ) then
    raise exception 'حساب راننده فعال نیست.';
  end if;

  select mi.ordered_quantity, coalesce(mi.loaded_quantity, 0), m.status::text
    into v_ordered, v_loaded, v_status
  from public.mission_items mi
  join public.missions m on m.id = mi.mission_id
  where mi.id = p_mission_item_id and m.driver_id = auth.uid()
  for update of mi;

  if not found then
    raise exception 'قلم مأموریت برای این راننده پیدا نشد.';
  end if;

  if p_stage = 'loaded' then
    if v_status <> 'loading' then
      raise exception 'ثبت بارگیری فقط در مرحله بارگیری مجاز است.';
    end if;
    update public.mission_items
      set loaded_quantity = v_ordered,
          discrepancy_note = null,
          checked_at = now()
    where id = p_mission_item_id;
  elsif p_stage = 'delivered' then
    if v_status <> 'on_the_way' then
      raise exception 'ثبت تحویل فقط در مرحله حرکت به سمت مشتری مجاز است.';
    end if;
    if v_loaded <> v_ordered then
      raise exception 'ابتدا باید بارگیری کامل این کالا ثبت شود.';
    end if;
    update public.mission_items
      set delivered_quantity = v_ordered,
          discrepancy_note = null,
          checked_at = now()
    where id = p_mission_item_id;
  else
    raise exception 'مرحله درخواستی معتبر نیست.';
  end if;
end;
$$;

revoke all on function public.driver_mark_mission_item_stage(uuid, text) from public;
grant execute on function public.driver_mark_mission_item_stage(uuid, text) to authenticated;


-- GO operational workflows: seller-approved extra trips, driver live location,
-- customer check confirmation without image uploads, and RLS repairs.
create or replace function public.go_is_active_seller()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.role::text = 'seller' and p.is_active = true
  );
$$;
grant execute on function public.go_is_active_seller() to authenticated;

-- Seller policies: seller can operate all business modules. Profile role changes stay protected.
do $$
declare t text;
begin
  foreach t in array array[
    'customers','customer_phones','orders','order_items','missions','mission_items',
    'driver_ledger','customer_checks','check_photos','cash_collections',
    'driver_settlements','mission_events','app_settings','audit_logs',
    'damage_reports','delivery_proofs','driver_freight_rates'
  ] loop
    if to_regclass('public.'||t) is not null then
      execute format('alter table public.%I enable row level security',t);
      execute format('grant select, insert, update, delete on public.%I to authenticated',t);
      execute format('drop policy if exists go_seller_full_access on public.%I',t);
      execute format(
        'create policy go_seller_full_access on public.%I for all to authenticated using (public.go_is_active_seller()) with check (public.go_is_active_seller())',
        t
      );
    end if;
  end loop;
end $$;

-- Drivers can read only customers and phone numbers linked to their own missions.
drop policy if exists go_driver_read_assigned_customers on public.customers;
create policy go_driver_read_assigned_customers on public.customers
for select to authenticated using (
  exists (
    select 1 from public.orders o
    join public.missions m on m.order_id = o.id
    where o.customer_id = customers.id and m.driver_id = auth.uid()
  )
);
drop policy if exists go_driver_read_assigned_customer_phones on public.customer_phones;
create policy go_driver_read_assigned_customer_phones on public.customer_phones
for select to authenticated using (
  exists (
    select 1 from public.orders o
    join public.missions m on m.order_id = o.id
    where o.customer_id = customer_phones.customer_id and m.driver_id = auth.uid()
  )
);

-- Customer check can be confirmed by the assigned driver in the mission screen;
-- seller then approves/rejects it. No photo is required.
alter table public.customer_checks
  add column if not exists driver_confirmed_by uuid references auth.users(id),
  add column if not exists driver_confirmed_at timestamptz;

create or replace function public.driver_confirm_customer_check(p_check_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not exists (
    select 1 from public.customer_checks cc
    join public.missions m on m.order_id = cc.order_id
    where cc.id = p_check_id and m.driver_id = auth.uid()
  ) then
    raise exception 'این چک به مأموریت شما تعلق ندارد.';
  end if;
  update public.customer_checks
  set driver_confirmed_by = auth.uid(),
      driver_confirmed_at = now(),
      status = 'awaiting_seller'
  where id = p_check_id and status::text not in ('approved','rejected');
  if not found then raise exception 'وضعیت این چک قابل تأیید نیست.'; end if;
end;
$$;
revoke all on function public.driver_confirm_customer_check(uuid) from public;
grant execute on function public.driver_confirm_customer_check(uuid) to authenticated;

-- Replace photo-dependent completion rule with driver confirmation + seller approval.
create or replace function public.go_guard_mission_completion()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.status::text = 'delivered' and old.status::text is distinct from 'delivered' then
    if exists (
      select 1 from public.orders o
      where o.id = new.order_id and coalesce(o.customer_cash_balance_toman, 0) > 0
    ) then
      raise exception 'ابتدا مانده نقدی مشتری باید تسویه شود.';
    end if;
    if exists (
      select 1 from public.cash_collections c
      where c.order_id = new.order_id and c.status::text in ('pending','awaiting_driver')
    ) then
      raise exception 'تأیید دریافت مانده نقدی مشتری باقی مانده است.';
    end if;
    if exists (
      select 1 from public.customer_checks cc
      where cc.order_id = new.order_id and (
        cc.status::text <> 'approved'
        or cc.driver_confirmed_at is null
      )
    ) then
      raise exception 'راننده باید چک را تأیید کند و فروشنده نیز آن را تأیید نهایی کند.';
    end if;
  end if;
  return new;
end;
$$;

-- Seller-defined store-paid round trips and driver-submitted third-party warehouse visits.
create table if not exists public.driver_extra_jobs (
  id uuid primary key default gen_random_uuid(),
  driver_id uuid not null references public.profiles(id),
  job_type text not null check (job_type in ('store_round_trip','other_warehouse')),
  title text not null,
  address text,
  amount_toman bigint not null check (amount_toman > 0),
  notes text,
  status text not null default 'assigned'
    check (status in ('assigned','pending_approval','approved','rejected')),
  created_by uuid references auth.users(id) default auth.uid(),
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  reviewed_by uuid references auth.users(id),
  reviewed_at timestamptz,
  review_note text
);
alter table public.driver_ledger
  add column if not exists extra_job_id uuid references public.driver_extra_jobs(id);
create unique index if not exists driver_ledger_extra_job_once
  on public.driver_ledger(extra_job_id) where extra_job_id is not null;
alter table public.driver_extra_jobs enable row level security;
grant select on public.driver_extra_jobs to authenticated;
grant insert, update on public.driver_extra_jobs to authenticated;
drop policy if exists go_seller_extra_jobs_all on public.driver_extra_jobs;
create policy go_seller_extra_jobs_all on public.driver_extra_jobs
for all to authenticated using (public.go_is_active_seller())
with check (public.go_is_active_seller());
drop policy if exists go_driver_extra_jobs_read on public.driver_extra_jobs;
create policy go_driver_extra_jobs_read on public.driver_extra_jobs
for select to authenticated using (driver_id = auth.uid());
drop policy if exists go_driver_extra_jobs_insert on public.driver_extra_jobs;
create policy go_driver_extra_jobs_insert on public.driver_extra_jobs
for insert to authenticated with check (
  driver_id = auth.uid() and job_type = 'other_warehouse' and status = 'pending_approval'
);
drop policy if exists go_driver_extra_jobs_update on public.driver_extra_jobs;
create policy go_driver_extra_jobs_update on public.driver_extra_jobs
for update to authenticated using (driver_id = auth.uid() and status = 'assigned')
with check (driver_id = auth.uid() and status = 'pending_approval');

create or replace function public.go_seller_create_round_trip(
  p_driver_id uuid, p_customer_name text, p_address text,
  p_amount_toman bigint, p_notes text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_id uuid;
begin
  if not public.go_is_active_seller() then raise exception 'دسترسی فروشنده لازم است.'; end if;
  if p_amount_toman <= 0 or nullif(trim(p_customer_name),'') is null then
    raise exception 'نام مشتری و مبلغ معتبر الزامی است.';
  end if;
  if not exists (select 1 from public.profiles where id=p_driver_id and role::text='driver' and is_active) then
    raise exception 'راننده فعال پیدا نشد.';
  end if;
  insert into public.driver_extra_jobs(driver_id,job_type,title,address,amount_toman,notes,status)
  values(p_driver_id,'store_round_trip','رفت‌وبرگشت مشتری: '||trim(p_customer_name),nullif(trim(p_address),''),p_amount_toman,nullif(trim(p_notes),''),'assigned')
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function public.go_seller_create_round_trip(uuid,text,text,bigint,text) from public;
grant execute on function public.go_seller_create_round_trip(uuid,text,text,bigint,text) to authenticated;

create or replace function public.go_driver_submit_warehouse_visit(
  p_title text, p_address text, p_amount_toman bigint, p_notes text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_id uuid;
begin
  if not exists (select 1 from public.profiles where id=auth.uid() and role::text='driver' and is_active) then
    raise exception 'حساب راننده فعال نیست.';
  end if;
  if p_amount_toman <= 0 or nullif(trim(p_title),'') is null then
    raise exception 'نام انبار و مبلغ معتبر الزامی است.';
  end if;
  insert into public.driver_extra_jobs(driver_id,job_type,title,address,amount_toman,notes,status)
  values(auth.uid(),'other_warehouse',trim(p_title),nullif(trim(p_address),''),p_amount_toman,nullif(trim(p_notes),''),'pending_approval')
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function public.go_driver_submit_warehouse_visit(text,text,bigint,text) from public;
grant execute on function public.go_driver_submit_warehouse_visit(text,text,bigint,text) to authenticated;

create or replace function public.go_driver_complete_extra_job(p_job_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.driver_extra_jobs
  set status='pending_approval', completed_at=now()
  where id=p_job_id and driver_id=auth.uid() and status='assigned';
  if not found then raise exception 'این مأموریت ویژه در دسترس یا قابل ثبت نیست.'; end if;
end;
$$;
revoke all on function public.go_driver_complete_extra_job(uuid) from public;
grant execute on function public.go_driver_complete_extra_job(uuid) to authenticated;

create or replace function public.go_seller_review_extra_job(
  p_job_id uuid, p_approved boolean, p_note text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_job public.driver_extra_jobs%rowtype;
begin
  if not public.go_is_active_seller() then raise exception 'دسترسی فروشنده لازم است.'; end if;
  select * into v_job from public.driver_extra_jobs where id=p_job_id for update;
  if not found or v_job.status <> 'pending_approval' then
    raise exception 'درخواست در انتظار تأیید پیدا نشد.';
  end if;
  update public.driver_extra_jobs
  set status=case when p_approved then 'approved' else 'rejected' end,
      reviewed_by=auth.uid(), reviewed_at=now(), review_note=nullif(trim(p_note),'')
  where id=p_job_id;
  if p_approved then
    insert into public.driver_ledger
      (driver_id,entry_type,amount_toman,description,created_by,extra_job_id)
    values
      (v_job.driver_id,'adjustment',v_job.amount_toman,
       'GO_EXTRA_JOB:'||v_job.id::text||': '||v_job.title,auth.uid(),v_job.id)
    on conflict (extra_job_id) where extra_job_id is not null do nothing;
  end if;
end;
$$;
revoke all on function public.go_seller_review_extra_job(uuid,boolean,text) from public;
grant execute on function public.go_seller_review_extra_job(uuid,boolean,text) to authenticated;

-- Driver live location: driver writes their own point; seller can see all active drivers.
create table if not exists public.driver_locations (
  driver_id uuid primary key references public.profiles(id) on delete cascade,
  latitude double precision not null check (latitude between -90 and 90),
  longitude double precision not null check (longitude between -180 and 180),
  updated_at timestamptz not null default now()
);
alter table public.driver_locations enable row level security;
grant select, insert, update on public.driver_locations to authenticated;
drop policy if exists go_seller_read_driver_locations on public.driver_locations;
create policy go_seller_read_driver_locations on public.driver_locations
for select to authenticated using (public.go_is_active_seller());
drop policy if exists go_driver_manage_own_location on public.driver_locations;
create policy go_driver_manage_own_location on public.driver_locations
for all to authenticated using (driver_id=auth.uid()) with check (driver_id=auth.uid());

-- Explicit read/update rights for the tariff table fix the previous 404/permission ambiguity.
grant select, insert, update, delete on public.driver_freight_rates to authenticated;
drop policy if exists go_seller_read_driver_freight_rates on public.driver_freight_rates;
drop policy if exists go_seller_insert_driver_freight_rates on public.driver_freight_rates;
create policy go_seller_freight_rates_all on public.driver_freight_rates
for all to authenticated using (public.go_is_active_seller())
with check (public.go_is_active_seller());

-- Allow drivers to read their own orders, so customer details and balances load inside their mission.
drop policy if exists go_driver_read_assigned_orders on public.orders;
create policy go_driver_read_assigned_orders on public.orders
for select to authenticated using (
  exists (select 1 from public.missions m where m.order_id=orders.id and m.driver_id=auth.uid())
);
