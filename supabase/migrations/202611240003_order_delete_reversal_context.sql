create or replace function public.go_seller_delete_order(p_order_id uuid)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare v_order public.orders%rowtype; v_mission_ids uuid[]; v_customer_name text; v_customer_address text;
begin
  if not public.go_is_active_seller() then raise exception 'دسترسی فروشنده لازم است.'; end if;
  select * into v_order from public.orders where id=p_order_id for update;
  if not found or v_order.deleted_at is not null then raise exception 'سفارش پیدا نشد یا قبلاً حذف شده است.'; end if;
  select coalesce(array_agg(id),array[]::uuid[]) into v_mission_ids from public.missions where order_id=p_order_id;
  select c.full_name,c.address into v_customer_name,v_customer_address from public.customers c where c.id=v_order.customer_id;
  if exists(select 1 from public.driver_ledger l join public.driver_settlements s on s.driver_id=l.driver_id and s.created_at>=l.created_at where (l.order_id=p_order_id or l.mission_id=any(v_mission_ids)) and l.amount_toman>0) then
    raise exception 'کرایه این سفارش در تسویه راننده لحاظ شده است؛ حذف مستقیم برای حفظ سوابق مالی مجاز نیست.';
  end if;
  insert into public.driver_ledger(driver_id,entry_type,amount_toman,related_entry_id,description,created_by)
  select l.driver_id,'adjustment',-l.amount_toman,l.id,'ابطال کرایه سفارش #'||v_order.order_number::text||' | مشتری: '||coalesce(v_customer_name,'ثبت نشده')||' | آدرس: '||coalesce(nullif(v_customer_address,''),'ثبت نشده')||' | '||coalesce(l.description,'تراکنش سفارش'),auth.uid()
  from public.driver_ledger l where (l.order_id=p_order_id or l.mission_id=any(v_mission_ids)) and l.amount_toman>0
    and not exists(select 1 from public.driver_ledger r where r.related_entry_id=l.id);
  update public.missions set status='cancelled',updated_at=now() where order_id=p_order_id;
  update public.orders set deleted_at=now(),status='cancelled',updated_at=now() where id=p_order_id;
end; $$;
revoke all on function public.go_seller_delete_order(uuid) from public;
grant execute on function public.go_seller_delete_order(uuid) to authenticated;
