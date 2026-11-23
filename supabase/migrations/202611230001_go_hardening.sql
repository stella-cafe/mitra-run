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
