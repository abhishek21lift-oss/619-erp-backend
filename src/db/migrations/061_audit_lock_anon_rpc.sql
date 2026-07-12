-- 061_audit_lock_anon_rpc.sql
-- Production audit remediation (H1 / remaining Warn-level RPC exposure).
-- Applied to the live database via Supabase migration `audit_lock_anon_rpc_functions`.
--
-- The four current_* helpers are SECURITY DEFINER functions used only by RLS
-- internally; the backend never calls them and connects as postgres/service_role
-- (which retain their explicit EXECUTE grants). Revoking from PUBLIC (the anon
-- path) and authenticated stops them being invoked via /rest/v1/rpc from the
-- Supabase Data API. After this, the security advisor reports only the three
-- (low-risk) extension-in-public warnings, which are intentionally left in place
-- because relocating pg_trgm/vector/unaccent would risk breaking fuzzy search
-- and vector indexes on the live database.
REVOKE EXECUTE ON FUNCTION public.current_user_id()   FROM PUBLIC, authenticated;
REVOKE EXECUTE ON FUNCTION public.current_user_role() FROM PUBLIC, authenticated;
REVOKE EXECUTE ON FUNCTION public.current_member_id() FROM PUBLIC, authenticated;
REVOKE EXECUTE ON FUNCTION public.current_branch_id() FROM PUBLIC, authenticated;
