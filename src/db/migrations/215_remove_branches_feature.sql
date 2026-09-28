-- 215_remove_branches_feature.sql
--
-- The Branches feature has been removed from the product: the settings page,
-- its sidebar/gear-menu entry and the /api/settings/branches routes are gone.
-- Its switch in the Command Center feature manager (seeded by 123) would now
-- toggle nothing, so the registry row goes too. plan_features and
-- organization_features reference platform_features(key) ON DELETE CASCADE,
-- so their rows for this key go with it.
--
-- Deliberately NOT touched: the `branch_*` rows in system_settings that held
-- any branches a studio created, and the legacy `branches` table. Nothing reads
-- them any more, and removing studio data is not something a code change
-- should do as a side effect.

DELETE FROM platform_features WHERE key = 'branches';
