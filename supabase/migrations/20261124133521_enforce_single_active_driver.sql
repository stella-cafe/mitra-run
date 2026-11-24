CREATE UNIQUE INDEX IF NOT EXISTS profiles_single_active_driver_idx
ON public.profiles (role)
WHERE role = 'driver'::public.app_role AND is_active = true;
