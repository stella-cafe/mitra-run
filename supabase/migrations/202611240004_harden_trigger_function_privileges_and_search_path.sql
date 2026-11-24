-- Harden internal trigger functions and the seller-role helper.
-- Trigger functions are invoked by PostgreSQL triggers, not by client RPC calls.
REVOKE ALL ON FUNCTION public.go_credit_driver_route_fee() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.go_enrich_driver_ledger_context() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.go_guard_mission_completion() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.go_queue_check_for_seller_review() FROM PUBLIC, anon, authenticated;

-- This helper is used by authenticated RLS policies; it must not be callable by anonymous clients.
REVOKE ALL ON FUNCTION public.go_is_active_seller() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.go_is_active_seller() TO authenticated;

-- Pin trigger-function search paths to prevent object-shadowing attacks.
ALTER FUNCTION public.set_updated_at() SET search_path = pg_catalog, public;
ALTER FUNCTION public.prevent_ledger_changes() SET search_path = pg_catalog, public;
