alter table public.orders add column if not exists deleted_at timestamptz;
alter table public.driver_extra_jobs add column if not exists deleted_at timestamptz;
alter table public.warehouse_visits add column if not exists deleted_at timestamptz;

create or replace function public.go_seller_delete_order(p_order_id uuid)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare v_order public.orders%rowtype; v_mission_ids uuid[];
begin
  if not public.go_is_active_seller() then raise exception 'دسترسی فروشنده لازم است.'; end if;
  select * into v_order from public.orders where id=p_order_id for update;
  if not found or v_order.deleted_at is not null then raise exception 'سفارش پیدا نشد یا قبلاً حذف شده است.'; end if;
  select coalesce(array_agg(id),array[]::uuid[]) into v_mission_ids from public.missions where order_id=p_order_id;
  if exists(select 1 from public.driver_ledger l join public.driver_settlements s on s.driver_id=l.driver_id and s.created_at>=l.created_at where (l.order_id=p_order_id or l.mission_id=any(v_mission_ids)) and l.amount_toman>0) then
    raise exception 'کرایه این سفارش در تسویه راننده لحاظ شده است؛ حذف مستقیم برای حفظ سوابق مالی مجاز نیست.';
  end if;
  insert into public.driver_ledger(driver_id,entry_type,amount_toman,related_entry_id,description,created_by)
  select l.driver_id,'adjustment',-l.amount_toman,l.id,'ابطال کرایه سفارش #'||v_order.order_number::text||' | '||coalesce(l.description,'تراکنش سفارش'),auth.uid()
  from public.driver_ledger l where (l.order_id=p_order_id or l.mission_id=any(v_mission_ids)) and l.amount_toman>0
    and not exists(select 1 from public.driver_ledger r where r.related_entry_id=l.id);
  update public.missions set status='cancelled',updated_at=now() where order_id=p_order_id;
  update public.orders set deleted_at=now(),status='cancelled',updated_at=now() where id=p_order_id;
end; $$;
revoke all on function public.go_seller_delete_order(uuid) from public;
grant execute on function public.go_seller_delete_order(uuid) to authenticated;

create or replace function public.go_delete_extra_job(p_job_id uuid)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare v_job public.driver_extra_jobs%rowtype;
begin
  select * into v_job from public.driver_extra_jobs where id=p_job_id for update;
  if not found or v_job.deleted_at is not null then raise exception 'مسیر پیدا نشد یا قبلاً حذف شده است.'; end if;
  if not public.go_is_active_seller() then
    if not exists(select 1 from public.profiles p where p.id=auth.uid() and p.role::text='driver' and p.is_active=true)
       or v_job.driver_id<>auth.uid() or v_job.status not in ('assigned','pending_approval') then
      raise exception 'فقط فروشنده یا راننده مربوطه برای مسیر در انتظار/در حال انجام اجازه حذف دارد.';
    end if;
  end if;
  if exists(select 1 from public.driver_ledger l join public.driver_settlements s on s.driver_id=l.driver_id and s.created_at>=l.created_at where l.extra_job_id=p_job_id and l.amount_toman>0) then
    raise exception 'این کرایه قبلاً در تسویه راننده لحاظ شده است؛ حذف مستقیم مجاز نیست.';
  end if;
  insert into public.driver_ledger(driver_id,entry_type,amount_toman,related_entry_id,description,created_by)
  select l.driver_id,'adjustment',-l.amount_toman,l.id,'ابطال کرایه مسیر: '||v_job.title||' | آدرس: '||coalesce(nullif(v_job.address,''),'ثبت نشده')||' | '||coalesce(l.description,'تراکنش مسیر'),auth.uid()
  from public.driver_ledger l where l.extra_job_id=p_job_id and l.amount_toman>0
    and not exists(select 1 from public.driver_ledger r where r.related_entry_id=l.id);
  update public.driver_extra_jobs set deleted_at=now() where id=p_job_id;
end; $$;
revoke all on function public.go_delete_extra_job(uuid) from public;
grant execute on function public.go_delete_extra_job(uuid) to authenticated;

create or replace function public.go_seller_delete_warehouse_visit(p_visit_id uuid)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare v_visit public.warehouse_visits%rowtype;
begin
  if not public.go_is_active_seller() then raise exception 'دسترسی فروشنده لازم است.'; end if;
  select * into v_visit from public.warehouse_visits where id=p_visit_id for update;
  if not found or v_visit.deleted_at is not null then raise exception 'مراجعه انبار پیدا نشد یا قبلاً حذف شده است.'; end if;
  if exists(select 1 from public.driver_ledger l join public.driver_settlements s on s.driver_id=l.driver_id and s.created_at>=l.created_at where l.warehouse_visit_id=p_visit_id and l.amount_toman>0) then
    raise exception 'این کرایه قبلاً در تسویه راننده لحاظ شده است؛ حذف مستقیم مجاز نیست.';
  end if;
  insert into public.driver_ledger(driver_id,entry_type,amount_toman,related_entry_id,description,created_by)
  select l.driver_id,'adjustment',-l.amount_toman,l.id,'ابطال کرایه مراجعه انبار: '||v_visit.warehouse_name||' | آدرس: '||coalesce(nullif(v_visit.address,''),'ثبت نشده'),auth.uid()
  from public.driver_ledger l where l.warehouse_visit_id=p_visit_id and l.amount_toman>0
    and not exists(select 1 from public.driver_ledger r where r.related_entry_id=l.id);
  update public.warehouse_visits set deleted_at=now() where id=p_visit_id;
end; $$;
revoke all on function public.go_seller_delete_warehouse_visit(uuid) from public;
grant execute on function public.go_seller_delete_warehouse_visit(uuid) to authenticated;
