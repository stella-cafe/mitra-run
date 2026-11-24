create or replace function public.go_enrich_driver_ledger_context()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare v_name text; v_address text;
begin
  if new.extra_job_id is not null then
    select title,address into v_name,v_address from public.driver_extra_jobs where id=new.extra_job_id;
    if found then new.description:=concat_ws(' | ',nullif(new.description,''),'مقصد: '||coalesce(v_name,'مسیر ویژه'),'آدرس: '||coalesce(nullif(v_address,''),'ثبت نشده')); end if;
  elsif new.warehouse_visit_id is not null then
    select warehouse_name,address into v_name,v_address from public.warehouse_visits where id=new.warehouse_visit_id;
    if found then new.description:=concat_ws(' | ',nullif(new.description,''),'مقصد: '||coalesce(v_name,'انبار'),'آدرس: '||coalesce(nullif(v_address,''),'ثبت نشده')); end if;
  elsif new.order_id is not null then
    select c.full_name,c.address into v_name,v_address from public.orders o join public.customers c on c.id=o.customer_id where o.id=new.order_id;
    if found then new.description:=concat_ws(' | ',nullif(new.description,''),'مشتری: '||coalesce(v_name,'ثبت نشده'),'آدرس: '||coalesce(nullif(v_address,''),'ثبت نشده')); end if;
  end if;
  return new;
end; $$;
drop trigger if exists go_enrich_driver_ledger_context on public.driver_ledger;
create trigger go_enrich_driver_ledger_context before insert on public.driver_ledger for each row execute function public.go_enrich_driver_ledger_context();
