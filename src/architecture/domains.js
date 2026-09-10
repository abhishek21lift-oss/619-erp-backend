'use strict';
// The domain manifest — the machine-readable form of the approved target
// architecture (Platform → Tenant → User → Role/Permission → Resource →
// Domain Module → Database).
//
// ── Why this file exists ────────────────────────────────────────────────────
//
// "Follow the approved domain boundaries" is not enforceable while the
// boundaries live only in a document. Every later phase of the migration —
// extracting modules, moving SQL into repositories, splitting pt-os, retiring
// legacy tables — needs one place to ask three questions and get the same
// answer every time:
//
//   Which domain owns this table?
//   Which plane does this domain serve?
//   Is this domain allowed to depend on that one?
//
// This is that place. It describes the TARGET, and the convention tests beside
// it (architecture.*.convention.test.js) measure how far the code currently is
// from it. Nothing here changes runtime behaviour: this phase makes the
// architecture checkable, it does not move a single route.
//
// ── The two things this file must never become ─────────────────────────────
//
// It must not drift from the schema. `tables` below names every table in
// src/db — the ownership test fails if the schema grows a table this file has
// not placed, and fails equally if this file names a table the schema does not
// have. A manifest that can quietly disagree with reality is worse than none,
// because it looks authoritative.
//
// It must not accumulate cycles. `dependsOn` is a DAG and the cycle test
// proves it. A cycle is resolved by extracting the shared concept downward or
// by inverting the edge with a domain event — never by adding the edge and
// moving on.

/**
 * The four planes. A domain serves exactly one.
 *
 * The plane decides the guard stack, so this is a security-relevant field, not
 * a label: PLATFORM and TENANT authorisation are never mixed, and PORTAL is a
 * plane rather than a role precisely so that a client identity cannot reach a
 * tenant route by satisfying a per-route check somebody forgot to add.
 */
const PLANE = Object.freeze({
  PLATFORM: 'platform',
  TENANT: 'tenant',
  PORTAL: 'portal',
  PUBLIC: 'public',
});

/**
 * How a row's owning studio is established.
 *
 *   direct    — the table carries organization_id itself.
 *   derived   — resolved through a parent, so its RLS policy needs BOTH a
 *               column check AND an EXISTS parent walk. Policies are
 *               PERMISSIVE and combine with OR, so a column-only policy on a
 *               derived table silently widens access. Migration 185 did
 *               exactly that and 186 restored it; architecture.rls-shape
 *               exists to stop the third occurrence.
 *   platform  — deliberately outside every tenant. Deny-all RLS.
 *   none      — reference/lookup data shared by all studios, no tenant column
 *               by design (exercise taxonomy, model rate cards).
 */
const TENANCY = Object.freeze({
  DIRECT: 'direct',
  DERIVED: 'derived',
  PLATFORM: 'platform',
  NONE: 'none',
});

/**
 * Lifecycle marker. `legacy` tables are still read by production code and are
 * retired only after a verified replacement (migration roadmap phase 6);
 * naming them here is what makes "remove obsolete architecture ONLY after
 * verified replacement" auditable rather than a promise.
 */
const STATUS = Object.freeze({
  ACTIVE: 'active',
  LEGACY: 'legacy',
});

const DOMAINS = {
  // ── Root ────────────────────────────────────────────────────────────────
  tenancy: {
    plane: PLANE.TENANT,
    tenancy: TENANCY.DIRECT,
    description: 'The tenant root: studios, their branches, and what they have bought.',
    dependsOn: [],
    tables: [
      'organizations', 'branches', 'organization_features', 'plan_features',
      'feature_flags', 'founder_members', 'system_settings',
    ],
  },

  'identity-access': {
    plane: PLANE.TENANT,
    tenancy: TENANCY.DIRECT,
    description: 'Login identity, credentials, sessions and invitations. Not employment.',
    dependsOn: ['tenancy'],
    tables: [
      'users', 'user_profiles', 'refresh_tokens', 'webauthn_credentials',
      'user_webauthn_credentials', 'webauthn_challenges', 'mfa_recovery_codes',
      'admin_invitations', 'client_invitations', 'login_events',
      'user_portfolio_items',
    ],
  },

  // ── Commercial ──────────────────────────────────────────────────────────
  'saas-billing': {
    plane: PLANE.TENANT,
    tenancy: TENANCY.DIRECT,
    description: 'What the STUDIO pays 619. Distinct from finance, which is what a client pays the studio.',
    dependsOn: ['tenancy'],
    tables: [
      'subscription_plans', 'subscription_invoices', 'subscription_payments',
      'subscription_events', 'subscription_coupons', 'subscription_coupon_redemptions',
      'subscription_payment_requests', 'trials', 'studio_registrations',
    ],
  },

  'crm-leads': {
    plane: PLANE.TENANT,
    tenancy: TENANCY.DIRECT,
    description: 'Prospects before they become clients.',
    dependsOn: ['tenancy', 'clients'],
    // `leads` and `lead_followups` are NOT here. Migration 012 created them;
    // 020_remove_lead_crm.sql dropped both. Neither exists after the
    // migrations finish applying, in production or a fresh bootstrap —
    // this domain owns only the table that is actually still there.
    tables: ['pt_leads'],
  },

  clients: {
    plane: PLANE.TENANT,
    tenancy: TENANCY.DIRECT,
    description: 'The PT client — the entity this product is built around.',
    dependsOn: ['tenancy', 'identity-access'],
    // `clients` is NOT here. schema.sql declares it (the pre-multitenancy
    // gym-ERP baseline schema.sql reconstructs for a fresh CI database), but
    // 170_drop_legacy_clients_and_renewals.sql drops it — with a verification
    // block that fails the migration if the table still exists afterward.
    // `members` genuinely survives to today; it stays.
    tables: [
      'pt_clients', 'client_fitness_profiles', 'pt_consent_records',
      'pt_family_medical_history', 'pt_medical_clearances',
      'members',
    ],
    legacyTables: ['members'],
  },

  'packages-enrolment': {
    plane: PLANE.TENANT,
    tenancy: TENANCY.DERIVED,
    description: 'What a client bought: packages, enrolment, renewal, freeze and session balance.',
    dependsOn: ['tenancy', 'clients'],
    // `subscriptions` and `renewals` are NOT here. Both are schema.sql
    // baseline tables; both are dropped — `subscriptions` by
    // 021_remove_members_feature.sql (CASCADE), `renewals` by that same
    // migration AND again, for a database old enough to still have it, by
    // 170. Confirmed live in production: PR #105 found Command Centre code
    // querying `subscriptions` directly and 500ing on every call, because
    // the table these two names refer to has not existed since 021 applied.
    tables: [
      'pt_packages', 'pt_plans', 'pt_client_subscriptions', 'pt_client_renewals',
      'holds_freezes', 'session_balance', 'membership_actions',
      'plans', 'member_memberships', 'membership_payments',
    ],
    legacyTables: ['plans', 'member_memberships', 'membership_payments'],
  },

  finance: {
    plane: PLANE.TENANT,
    tenancy: TENANCY.DIRECT,
    description: 'What a CLIENT pays the studio: payments, invoices, expenses, receipts.',
    dependsOn: ['tenancy', 'clients', 'packages-enrolment'],
    // pt_payments is the single payment ledger. The legacy `payments` table
    // that sat at the end of this list — and in legacyTables beside it — is
    // dropped by migration 191; it had no organization_id, so nothing it held
    // could be attributed to a studio.
    tables: [
      'pt_payments', 'payment_orders', 'payment_submissions', 'payment_settings',
      'payment_audit_logs', 'invoices', 'invoice_items', 'expenses', 'receipt_counter',
    ],
  },

  compensation: {
    plane: PLANE.TENANT,
    tenancy: TENANCY.DIRECT,
    description: 'Employment records and what the studio pays its staff.',
    dependsOn: ['tenancy', 'finance', 'scheduling'],
    // Neither `staff`/`staff_targets` nor `staff_new`/`staff_targets_new`
    // are here. Migration 033 creates the "_new" pair and, in the same file,
    // `ALTER TABLE ... RENAME TO staff` / `staff_targets` — so the "_new"
    // names never persist past that one migration. Migration 064 then drops
    // the renamed pair for good ("Removes the Staff & Access / Team
    // Management module entirely, per explicit request. Both tables were
    // empty (0 rows) at removal time"), and nothing recreates them after.
    // Personnel management lives entirely on `trainers`/`pt_trainers` now,
    // matching 064's own note that a `staff` ROLE VALUE on users.role is a
    // separate, unrelated thing this migration did not touch.
    //
    // Production still carries `staff` and `staff_targets` as of this
    // writing — 0 rows in both, and no current backend code reads either —
    // an orphan the drop should have removed. That is 26th-and-27th-table
    // territory (see the roadmap phase 2 reconciliation), not something this
    // domain owns.
    tables: [
      'pt_commissions', 'pt_payouts',
      'revenue_targets', 'pt_trainers', 'trainers',
      'leave_requests',
    ],
  },

  // ── Delivery ────────────────────────────────────────────────────────────
  scheduling: {
    plane: PLANE.TENANT,
    tenancy: TENANCY.DERIVED,
    description: 'When training happens. Sessions, trials and calendar sync.',
    dependsOn: ['tenancy', 'clients', 'packages-enrolment'],
    tables: [
      'pt_sessions', 'trial_sessions', 'google_calendar_events', 'google_calendar_tokens',
    ],
  },

  training: {
    plane: PLANE.TENANT,
    tenancy: TENANCY.DERIVED,
    description: 'The programme and its execution: exercises, plans, logged sets, records.',
    dependsOn: ['tenancy', 'clients', 'scheduling'],
    tables: [
      'exercises', 'exercise_categories', 'exercise_muscles', 'exercise_relations',
      'exercise_versions', 'exercise_favorites', 'exercise_recent_usage',
      'exercise_performances', 'muscles', 'muscle_volume_landmarks', 'equipment_types',
      'workout_plans', 'workout_templates', 'workout_template_exercises',
      'workout_exercises', 'workout_assignments', 'workout_sessions',
      'workout_session_exercises', 'workout_sets', 'set_performances',
      'cardio_performances', 'personal_records', 'strength_logs',
      'training_programs', 'training_program_phases', 'training_program_weeks',
      'training_assignments', 'training_sessions',
    ],
  },

  assessments: {
    plane: PLANE.TENANT,
    tenancy: TENANCY.DERIVED,
    description: 'Everything measured about a client: screening, assessment, progress.',
    dependsOn: ['tenancy', 'clients', 'files-storage'],
    tables: [
      'pt_assessments', 'pt_parq_forms', 'pt_parq_documents', 'pt_informed_consents',
      'pt_posture_assessments', 'pt_mobility_performance_assessments',
      'pt_nutrition_assessments', 'pt_lifestyle_assessments', 'pt_os_measurements',
      'body_metrics', 'progress_photos', 'weekly_checkins', 'pt_goals', 'weight_logs',
    ],
  },

  nutrition: {
    plane: PLANE.TENANT,
    tenancy: TENANCY.DERIVED,
    description: 'Diet templates, assignments and logging.',
    dependsOn: ['tenancy', 'clients'],
    tables: ['diet_templates', 'diet_plan_meals', 'diet_assignments', 'meals', 'nutrition_logs'],
  },

  attendance: {
    plane: PLANE.TENANT,
    tenancy: TENANCY.DIRECT,
    description: 'Check-in. QR is the supported path; face and biometric are gym-ERP inheritance.',
    dependsOn: ['tenancy', 'clients'],
    tables: [
      'attendance', 'attendance_logs', 'qr_tokens',
      'face_descriptors', 'face_checkin_logs', 'biometric_attendance',
    ],
    legacyTables: ['face_descriptors', 'face_checkin_logs', 'biometric_attendance'],
  },

  'group-classes': {
    plane: PLANE.TENANT,
    tenancy: TENANCY.DIRECT,
    status: STATUS.LEGACY,
    description:
      'Group-class scheduling and booking. Named as its own domain rather than hidden '
      + 'inside scheduling so the retire-or-promote decision stays visible: this is '
      + 'gym-ERP surface in a PT-first product, and the decision needs live usage '
      + 'evidence the code cannot supply.',
    dependsOn: ['tenancy', 'clients'],
    tables: ['class_sessions', 'class_templates', 'bookings'],
  },

  // ── Communication ───────────────────────────────────────────────────────
  engagement: {
    plane: PLANE.TENANT,
    tenancy: TENANCY.DIRECT,
    description: 'Reaching clients: campaigns, offers, feedback, automation, notifications.',
    dependsOn: ['tenancy', 'clients', 'messaging'],
    tables: [
      'campaigns', 'offers', 'feedback', 'communication_history', 'communication_logs',
      'automation_rules', 'notifications', 'notification_log', 'churn_risk_log',
    ],
  },

  messaging: {
    plane: PLANE.TENANT,
    tenancy: TENANCY.DIRECT,
    description:
      'WhatsApp device pairing, delivery, and who is permitted to send automatically. '
      + 'Talks to the external gateway service.',
    // `compensation` because whatsapp_automation_trainer_grants references
    // `trainers`, which that domain owns. Declared rather than left implicit:
    // a foreign key IS a dependency, and the one direction that would be wrong
    // is engagement → messaging → engagement, which this is not — compensation
    // reaches only tenancy, finance and scheduling.
    dependsOn: ['tenancy', 'compensation'],
    tables: [
      'whatsapp_instances', 'whatsapp_webhook_events',
      // The permission gate for automated sending. It lives here rather than
      // with automation_rules in `engagement` because it is about DELIVERY —
      // whether this studio's WhatsApp may be used unattended, and on whose
      // behalf — not about which events produce which messages. engagement
      // already depends on messaging, so the direction holds: a rule cannot
      // fire without permission, and permission knows nothing about rules.
      'whatsapp_automation_settings', 'whatsapp_automation_trainer_grants',
    ],
  },

  integrations: {
    plane: PLANE.TENANT,
    tenancy: TENANCY.DIRECT,
    description: 'Third-party credentials a studio pastes in. Device pairings live in messaging.',
    dependsOn: ['tenancy'],
    tables: ['integrations'],
  },

  ai: {
    plane: PLANE.TENANT,
    tenancy: TENANCY.DIRECT,
    description: 'Knowledge base, assistants and agent tasks. Quota-gated per studio.',
    dependsOn: ['tenancy', 'clients', 'training', 'nutrition'],
    tables: [
      'ai_documents', 'ai_document_chunks', 'ai_conversations', 'ai_messages',
      'ai_usage_log', 'ai_action_plans', 'ai_model_rates', 'ai_provider_settings',
      'agent_tasks', 'agent_audit_log', 'organization_ai_limits',
    ],
  },

  operations: {
    plane: PLANE.TENANT,
    tenancy: TENANCY.DIRECT,
    description: 'Studio operating records that belong to no single delivery domain.',
    dependsOn: ['tenancy'],
    tables: ['module_records'],
  },

  'files-storage': {
    plane: PLANE.TENANT,
    tenancy: TENANCY.DIRECT,
    description: 'Object-storage bookkeeping. Keys are tenant-prefixed; URLs are signed per request.',
    dependsOn: ['tenancy'],
    tables: ['storage_objects', 'storage_accounting_meta'],
  },

  // ── Read-only leaves ────────────────────────────────────────────────────
  insights: {
    plane: PLANE.TENANT,
    tenancy: TENANCY.DERIVED,
    readOnly: true,
    description:
      'Reporting and search. Owns no tables and writes nothing — it reads through the '
      + 'owning domains, which is what keeps a reporting query from becoming a second, '
      + 'unscoped read path onto somebody else\'s data.',
    dependsOn: [
      'clients', 'packages-enrolment', 'finance', 'scheduling', 'training',
      'attendance', 'compensation', 'engagement',
    ],
    tables: [],
  },

  'client-portal': {
    plane: PLANE.PORTAL,
    tenancy: TENANCY.DERIVED,
    readOnly: true,
    description:
      'What a client sees about themselves. A plane, not a role: it owns no tables and '
      + 'every read resolves the session org AND the caller\'s own client id.',
    dependsOn: ['clients', 'scheduling', 'training', 'assessments', 'finance', 'nutrition'],
    tables: [],
  },

  // ── Outside every tenant ────────────────────────────────────────────────
  platform: {
    plane: PLANE.PLATFORM,
    tenancy: TENANCY.PLATFORM,
    description:
      'The 619 operator plane. Deny-all RLS on these tables: the app_tenant role has no '
      + 'business reading them, and a deny-all policy still holds if a grant is added by '
      + 'accident. Platform reads of TENANT tables go through the owner connection.',
    dependsOn: [],
    tables: [
      'platform_owners', 'platform_features', 'platform_announcements',
      'platform_billing_settings', 'platform_payment_settings', 'platform_ai_settings',
      'ai_platform_settings', 'system_alerts', 'system_logs',
      // `support_tickets` and `support_ticket_messages` are NOT here. See the
      // `support` domain below: they carry organization_id and are read AND
      // written by routes/support.js on the tenant plane, so classifying them
      // as platform data was a misreading of "the platform console can see
      // them" as "they belong to the platform". By that reasoning pt_clients
      // would be platform data too — the console reads that as well, over the
      // owner connection, which is how platform reads of tenant tables always
      // work.
      'tenancy_known_gaps', 'tenancy_isolation_runs', 'admin_reset_intents',
    ],
  },

  // ── Support: tenant data with a platform-side console ───────────────────
  support: {
    plane: PLANE.TENANT,
    tenancy: TENANCY.DIRECT,
    description:
      'Studio-raised support tickets and their conversation. Tenant data: a studio '
      + 'opens a ticket, reads its own, and replies. The 619 operator answers from the '
      + 'platform console over the owner connection, exactly as it reads any other '
      + 'tenant table. Internal operator notes live in the same message table behind '
      + 'is_internal and are excluded from the tenant both in SQL (lib/support.js) and '
      + 'in the row policy (migration 189).',
    dependsOn: ['tenancy', 'identity-access'],
    tables: ['support_tickets', 'support_ticket_messages'],
  },

  audit: {
    plane: PLANE.TENANT,
    tenancy: TENANCY.DIRECT,
    description:
      'Who did what to which studio\'s data. Append-only. Every domain writes here; '
      + 'no domain reads another\'s rows through it.',
    dependsOn: ['tenancy'],
    tables: ['audit_log', 'activity_log'],
  },
};

// ── Derived views ──────────────────────────────────────────────────────────

/** table name → owning domain name. Built once; duplicates are a manifest bug. */
const OWNER_OF = (() => {
  const map = new Map();
  for (const [domain, spec] of Object.entries(DOMAINS)) {
    for (const table of spec.tables) {
      if (map.has(table)) {
        throw new Error(
          `domain manifest: "${table}" is claimed by both "${map.get(table)}" and "${domain}". `
          + 'A table has exactly one owner.',
        );
      }
      map.set(table, domain);
    }
  }
  return map;
})();

function ownerOf(table) {
  return OWNER_OF.get(table) || null;
}

function allTables() {
  return [...OWNER_OF.keys()].sort();
}

/**
 * Tables whose tenancy matches one model — `derived` being the one that
 * matters, because those are the tables whose RLS policy needs a parent walk
 * and whose parent walk a column-only sweep silently removes.
 */
function tablesByTenancy(model) {
  const out = [];
  for (const spec of Object.values(DOMAINS)) {
    if (spec.tenancy === model) out.push(...spec.tables);
  }
  return out.sort();
}

function legacyTables() {
  const out = [];
  for (const spec of Object.values(DOMAINS)) {
    for (const t of spec.legacyTables || []) out.push(t);
  }
  return out.sort();
}

/**
 * Every dependency cycle in the manifest, as readable paths.
 *
 * Depth-first with an explicit on-stack set: when an edge reaches a node
 * already on the current path, the slice from that node to here IS the cycle,
 * so the failure message can name it rather than saying "a cycle exists".
 */
function findCycles() {
  const cycles = [];
  const seen = new Set();
  const stack = [];
  const onStack = new Set();

  function walk(name) {
    if (onStack.has(name)) {
      cycles.push([...stack.slice(stack.indexOf(name)), name].join(' → '));
      return;
    }
    if (seen.has(name)) return;
    seen.add(name);
    stack.push(name);
    onStack.add(name);
    for (const dep of DOMAINS[name]?.dependsOn || []) walk(dep);
    stack.pop();
    onStack.delete(name);
  }

  for (const name of Object.keys(DOMAINS)) walk(name);
  return [...new Set(cycles)];
}

/** Domain names whose dependsOn references a domain that does not exist. */
function danglingDependencies() {
  const out = [];
  for (const [name, spec] of Object.entries(DOMAINS)) {
    for (const dep of spec.dependsOn) {
      if (!DOMAINS[dep]) out.push(`${name} → ${dep}`);
    }
  }
  return out;
}

module.exports = {
  PLANE,
  TENANCY,
  STATUS,
  DOMAINS,
  ownerOf,
  allTables,
  tablesByTenancy,
  legacyTables,
  findCycles,
  danglingDependencies,
};
