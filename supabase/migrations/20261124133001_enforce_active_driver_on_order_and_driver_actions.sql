-- Require a valid active driver for every new order, even if a caller bypasses the UI.
DO $migration$
DECLARE
  v_def text;
  v_new text;
BEGIN
  v_def := pg_get_functiondef(
    'public.seller_create_order(uuid,text,text,text,double precision,double precision,bigint,bigint,bigint,integer,text,jsonb,uuid)'::regprocedure
  );
  v_new := regexp_replace(
    v_def,
    'if p_driver_id is not null[[:space:]]+and not exists\(',
    'if p_driver_id is null or not exists(',
    'g'
  );
  IF v_new = v_def THEN
    RAISE EXCEPTION 'Expected seller_create_order driver validation block was not found; migration aborted.';
  END IF;
  EXECUTE v_new;
END
$migration$;

CREATE OR REPLACE FUNCTION public.driver_confirm_customer_check(p_check_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF NOT public.is_active_driver() THEN
    RAISE EXCEPTION 'حساب راننده فعال نیست.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.customer_checks cc
    JOIN public.missions m ON m.order_id = cc.order_id
    WHERE cc.id = p_check_id AND m.driver_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'این چک به مأموریت شما تعلق ندارد.';
  END IF;
  UPDATE public.customer_checks
  SET driver_confirmed_by = auth.uid(),
      driver_confirmed_at = COALESCE(driver_confirmed_at, now()),
      status = CASE WHEN status::text = 'approved' THEN status ELSE 'awaiting_seller' END
  WHERE id = p_check_id AND status::text <> 'rejected';
  IF NOT FOUND THEN RAISE EXCEPTION 'وضعیت این چک قابل تأیید نیست.'; END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.go_driver_complete_extra_job(p_job_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_job public.driver_extra_jobs%rowtype;
BEGIN
  IF NOT public.is_active_driver() THEN
    RAISE EXCEPTION 'حساب راننده فعال نیست.';
  END IF;
  SELECT * INTO v_job
  FROM public.driver_extra_jobs
  WHERE id = p_job_id AND driver_id = auth.uid() AND status = 'assigned'
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'این مأموریت ویژه در دسترس یا قابل ثبت نیست.'; END IF;

  IF v_job.job_type = 'store_round_trip' THEN
    UPDATE public.driver_extra_jobs
    SET status = 'approved', completed_at = now(), reviewed_at = now(),
        review_note = 'از قبل توسط فروشنده به‌عنوان هزینه فروشگاه تأیید شده است.'
    WHERE id = p_job_id;
    INSERT INTO public.driver_ledger
      (driver_id, entry_type, amount_toman, description, created_by, extra_job_id)
    VALUES
      (v_job.driver_id, 'adjustment', v_job.amount_toman,
       'GO_EXTRA_JOB:' || v_job.id::text || ': ' || v_job.title, auth.uid(), v_job.id)
    ON CONFLICT (extra_job_id) WHERE extra_job_id IS NOT NULL DO NOTHING;
  ELSE
    UPDATE public.driver_extra_jobs SET status = 'pending_approval', completed_at = now()
    WHERE id = p_job_id;
  END IF;
END;
$function$;
