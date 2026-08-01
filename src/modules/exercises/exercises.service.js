'use strict';
// The exercise library — query building, permissions, slugs and versioning.
//
// Split from the HTTP layer so the rules that matter (who may edit what, what
// a studio can see, what a slug becomes) are testable without a server or a
// database socket.
//
// ── Visibility ──────────────────────────────────────────────────────────────
//
// Two kinds of row live in this table, distinguished by organization_id:
//
//   NULL      the shared platform library — the ~890 imported movements every
//             studio sees and none may edit.
//   set       a studio's own custom exercise ("619 Deadlift"), visible only
//             to that studio.
//
// Every read is therefore "mine OR shared", never a bare SELECT. A studio
// must not be able to enumerate another studio's programming.

const { randomUUID } = require('crypto');

/** Columns returned to a list view — enough to render a card, no more. */
const LIST_COLUMNS = `
  e.id, e.name, e.slug, e.muscle_group, e.body_part, e.target_muscle,
  e.secondary_muscles, e.category, e.equipment, e.difficulty, e.force,
  e.mechanic, e.movement_pattern, e.plane_of_motion, e.exercise_type,
  e.tags, e.visibility, e.organization_id, e.archived_at, e.is_active,
  e.sets_default, e.reps_default, e.rest_seconds,
  e.created_by, e.updated_by, e.created_at, e.updated_at, e.version
`;

/** Everything, for a detail view or an edit form. */
const DETAIL_COLUMNS = `
  ${LIST_COLUMNS},
  e.description, e.instructions, e.coaching_cues, e.common_mistakes,
  e.safety_tips, e.breathing_tips, e.tempo_recommendation,
  e.beginner_notes, e.advanced_notes, e.contraindications, e.trainer_notes,
  e.search_keywords, e.gif_url, e.video_url, e.image_url, e.source_id
`;

/**
 * Writable fields, and how to coerce each one.
 *
 * A single list drives create, update and the version snapshot, so a new
 * field cannot be accepted by one and silently dropped by another — which is
 * exactly how the legacy PUT ended up able to edit only name and
 * instructions while the form showed a dozen fields.
 */
const TEXT_FIELDS = [
  'name', 'description', 'muscle_group', 'body_part', 'target_muscle',
  'secondary_muscles', 'category', 'equipment', 'difficulty', 'force',
  'mechanic', 'movement_pattern', 'plane_of_motion', 'exercise_type',
  'instructions', 'coaching_cues', 'common_mistakes', 'safety_tips',
  'breathing_tips', 'tempo_recommendation', 'beginner_notes',
  'advanced_notes', 'contraindications', 'trainer_notes',
  'gif_url', 'video_url', 'image_url',
];
const INT_FIELDS = ['sets_default', 'reps_default', 'rest_seconds'];
const ARRAY_FIELDS = ['tags', 'search_keywords'];

const DIFFICULTIES = ['beginner', 'intermediate', 'advanced'];
const MUSCLE_GROUPS = [
  'Chest', 'Back', 'Legs', 'Shoulders', 'Arms', 'Core', 'Cardio',
  'Full Body', 'Neck', 'Olympic',
];

/**
 * URL-safe identifier for a name. Must match the SQL in migration 141 so a
 * slug generated here and one backfilled there are the same string.
 */
function slugify(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * A slug nothing else is using, within the scope that must be unique.
 *
 * Loops rather than trusting a single candidate: two trainers naming an
 * exercise the same thing in the same second would otherwise collide on the
 * unique index and surface as a 500. The suffix is numeric and sequential so
 * the result stays readable ("landmine-squat-2"), unlike the id-fragment
 * suffix the backfill uses, which only had to be deterministic.
 */
async function uniqueSlug(db, name, { excludeId = null } = {}) {
  const base = slugify(name) || 'exercise';
  for (let n = 0; n < 50; n++) {
    const candidate = n === 0 ? base : `${base}-${n + 1}`;
    const { rows } = await db.query(
      `SELECT 1 FROM exercises
        WHERE slug = $1 AND deleted_at IS NULL AND ($2::text IS NULL OR id <> $2)
        LIMIT 1`,
      [candidate, excludeId]
    );
    if (!rows[0]) return candidate;
  }
  // Fifty taken variants means something pathological; fall back to something
  // that cannot collide rather than looping forever.
  return `${base}-${randomUUID().slice(0, 8)}`;
}

/**
 * Keywords a trainer might type that are not already the name.
 *
 * Generated on write so search stays useful for custom exercises without the
 * trainer having to think about SEO. Anything they typed themselves is kept
 * and merged, never overwritten.
 */
function buildSearchKeywords(row, explicit) {
  const source = [
    row.target_muscle, row.muscle_group, row.body_part, row.equipment,
    row.exercise_type, row.force, row.mechanic, row.category,
    row.movement_pattern,
    ...(Array.isArray(explicit) ? explicit : []),
    ...(Array.isArray(row.tags) ? row.tags : []),
  ];
  const seen = new Set();
  for (const raw of source) {
    if (raw == null) continue;
    const v = String(raw).trim().toLowerCase();
    if (v) seen.add(v);
  }
  return [...seen];
}

/** Normalise a tags/keywords input: array or comma-separated string. */
function toArray(v) {
  if (v == null) return null;
  const list = Array.isArray(v) ? v : String(v).split(',');
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const s = String(item).trim();
    if (!s) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

// ── Permissions ─────────────────────────────────────────────────────────────
//
// Per the product rule: admin full access; trainer may create custom
// exercises and edit their own; staff is read-only. Manager is treated as
// admin here — it already is everywhere else in this file's neighbourhood.
//
// The shared platform library (organization_id IS NULL) is editable by
// nobody through the API. It is shared across every studio, so one studio
// "fixing" a cue would silently rewrite it for all of them. A studio that
// wants its own version duplicates it, which is what duplicate() is for.

const WRITE_ROLES = ['admin', 'manager', 'trainer', 'super_admin'];

function canCreate(user) {
  return WRITE_ROLES.includes(user?.role);
}

/**
 * @returns {{ok: true} | {ok: false, status: number, message: string}}
 */
function canModify(user, exercise) {
  if (!exercise) return { ok: false, status: 404, message: 'Exercise not found' };
  if (!canCreate(user)) {
    return { ok: false, status: 403, message: 'You do not have permission to edit exercises' };
  }
  if (exercise.organization_id == null) {
    return {
      ok: false,
      status: 403,
      message: 'This is a shared library exercise and cannot be edited. Duplicate it to make your own version.',
    };
  }
  const role = user?.role;
  if (role === 'trainer' && exercise.created_by !== user.id) {
    return {
      ok: false,
      status: 403,
      message: 'Trainers can only edit exercises they created. Duplicate it to make your own version.',
    };
  }
  return { ok: true };
}

// ── Reads ───────────────────────────────────────────────────────────────────

/**
 * Build the WHERE clause shared by list() and count().
 *
 * `params`/`p` are threaded through rather than rebuilt so the two queries
 * cannot drift into filtering differently — a count that disagrees with its
 * own list is a pagination bug that only shows up on the last page.
 */
function buildFilters(q, orgId, params) {
  const conds = ['e.deleted_at IS NULL'];
  const add = (sql, val) => { params.push(val); conds.push(sql.replace('$?', `$${params.length}`)); };

  // Visibility: this studio's own customs, plus the shared library.
  params.push(orgId);
  conds.push(`(e.organization_id IS NULL OR e.organization_id = $${params.length}::uuid)`);

  if (q.archived === 'true') conds.push('e.archived_at IS NOT NULL');
  else if (q.archived === 'all') { /* no filter */ }
  else conds.push('e.archived_at IS NULL');

  if (q.muscle_group)     add('e.muscle_group = $?', q.muscle_group);
  if (q.body_part)        add('e.body_part = $?', q.body_part);
  if (q.equipment)        add('e.equipment = $?', q.equipment);
  if (q.exercise_type)    add('e.exercise_type = $?', q.exercise_type);
  if (q.difficulty)       add('e.difficulty = $?', q.difficulty);
  if (q.category)         add('e.category = $?', q.category);
  if (q.movement_pattern) add('e.movement_pattern = $?', q.movement_pattern);
  if (q.target_muscle)    add('e.target_muscle = $?', q.target_muscle);
  // mechanic is compound/isolation; force is push/pull. Both are free text in
  // the imported data, so compare case-insensitively.
  if (q.mechanic)         add('lower(e.mechanic) = lower($?)', q.mechanic);
  if (q.force)            add('lower(e.force) = lower($?)', q.force);
  if (q.custom === 'true')  conds.push('e.organization_id IS NOT NULL');
  if (q.custom === 'false') conds.push('e.organization_id IS NULL');
  if (q.tag)              add('e.tags @> ARRAY[$?]::text[]', q.tag);

  if (q.favorites === 'true') {
    conds.push('fav.exercise_id IS NOT NULL');
  }

  // Search: full-text first, trigram as the safety net. websearch_to_tsquery
  // never throws on user input (plainto_/to_tsquery do), which matters for a
  // box the user types into on every keystroke. The ILIKE arm catches
  // substrings and typos that stemming misses — "bicep" vs "biceps", or a
  // partial word mid-token.
  if (q.search && String(q.search).trim()) {
    const term = String(q.search).trim();
    params.push(term);
    const t = `$${params.length}`;
    params.push(`%${term}%`);
    const like = `$${params.length}`;
    conds.push(`(e.search_vector @@ websearch_to_tsquery('english', ${t}) OR e.name ILIKE ${like})`);
  }

  return conds;
}

const SORTS = {
  name: 'e.name ASC',
  name_desc: 'e.name DESC',
  newest: 'e.created_at DESC',
  oldest: 'e.created_at ASC',
  updated: 'e.updated_at DESC',
  difficulty: `CASE e.difficulty WHEN 'beginner' THEN 1 WHEN 'intermediate' THEN 2 WHEN 'advanced' THEN 3 ELSE 4 END, e.name ASC`,
};

async function list(db, { query = {}, user, orgId }) {
  const params = [];
  const conds = buildFilters(query, orgId, params);

  // Favourites and recents are LEFT JOINed rather than fetched separately so
  // a card can render its filled-in heart without a second round trip per
  // page — and so `favorites=true` can filter on it.
  params.push(user.id);
  const userParam = `$${params.length}`;
  const joins = `
    LEFT JOIN exercise_favorites fav ON fav.exercise_id = e.id AND fav.user_id = ${userParam}
    LEFT JOIN exercise_recent_uses rec ON rec.exercise_id = e.id AND rec.user_id = ${userParam}
  `;

  // Snapshotted BEFORE any ORDER BY parameter is added. The count query uses
  // the same WHERE and joins but no ORDER BY, so handing it the ranking
  // parameter too makes Postgres reject the bind: "supplies 5 parameters, but
  // prepared statement requires 4".
  const countParams = [...params];

  let orderBy = SORTS[query.sort] || SORTS.name;
  // Relevance only means something when there is a query to be relevant to.
  if (query.sort === 'relevance' && query.search) {
    params.push(String(query.search).trim());
    orderBy = `ts_rank(e.search_vector, websearch_to_tsquery('english', $${params.length})) DESC, e.name ASC`;
  } else if (query.sort === 'recent') {
    orderBy = 'rec.last_used_at DESC NULLS LAST, e.name ASC';
  }

  const limit = Math.min(Math.max(parseInt(query.limit, 10) || 40, 1), 200);
  const page = Math.max(parseInt(query.page, 10) || 1, 1);
  const offset = query.offset != null
    ? Math.max(parseInt(query.offset, 10) || 0, 0)
    : (page - 1) * limit;

  const where = conds.join(' AND ');
  const { rows } = await db.query(
    `SELECT ${LIST_COLUMNS},
            (fav.exercise_id IS NOT NULL) AS is_favorite,
            rec.last_used_at
       FROM exercises e ${joins}
      WHERE ${where}
      ORDER BY ${orderBy}
      LIMIT ${limit} OFFSET ${offset}`,
    params
  );

  const { rows: [cnt] } = await db.query(
    `SELECT COUNT(*)::int AS total FROM exercises e ${joins} WHERE ${where}`,
    countParams
  );

  return {
    data: rows,
    pagination: {
      total: cnt.total,
      page: Math.floor(offset / limit) + 1,
      limit,
      pages: Math.max(Math.ceil(cnt.total / limit), 1),
    },
  };
}

async function getById(db, idOrSlug, { user, orgId }) {
  const { rows } = await db.query(
    `SELECT ${DETAIL_COLUMNS},
            (fav.exercise_id IS NOT NULL) AS is_favorite
       FROM exercises e
       LEFT JOIN exercise_favorites fav ON fav.exercise_id = e.id AND fav.user_id = $2
      WHERE (e.id = $1 OR e.slug = $1)
        AND e.deleted_at IS NULL
        AND (e.organization_id IS NULL OR e.organization_id = $3::uuid)
      LIMIT 1`,
    [idOrSlug, user.id, orgId]
  );
  const exercise = rows[0];
  if (!exercise) return null;

  const { rows: relations } = await db.query(
    `SELECT r.kind, r.sort_order, e.id, e.name, e.slug, e.difficulty, e.equipment
       FROM exercise_relations r
       JOIN exercises e ON e.id = r.related_id AND e.deleted_at IS NULL
      WHERE r.exercise_id = $1
      ORDER BY r.kind, r.sort_order, e.name`,
    [exercise.id]
  );

  return {
    ...exercise,
    regressions: relations.filter((r) => r.kind === 'regression'),
    progressions: relations.filter((r) => r.kind === 'progression'),
    alternatives: relations.filter((r) => r.kind === 'alternative'),
  };
}

/** Distinct values for the filter dropdowns, within what this studio can see. */
async function meta(db, { orgId }) {
  const { rows: [m] } = await db.query(
    `SELECT
       array_agg(DISTINCT body_part        ORDER BY body_part)        FILTER (WHERE body_part IS NOT NULL)        AS body_parts,
       array_agg(DISTINCT muscle_group     ORDER BY muscle_group)     FILTER (WHERE muscle_group IS NOT NULL)     AS muscle_groups,
       array_agg(DISTINCT target_muscle    ORDER BY target_muscle)    FILTER (WHERE target_muscle IS NOT NULL)    AS target_muscles,
       array_agg(DISTINCT equipment        ORDER BY equipment)        FILTER (WHERE equipment IS NOT NULL)        AS equipment_types,
       array_agg(DISTINCT exercise_type    ORDER BY exercise_type)    FILTER (WHERE exercise_type IS NOT NULL)    AS exercise_types,
       array_agg(DISTINCT category         ORDER BY category)         FILTER (WHERE category IS NOT NULL)         AS categories,
       array_agg(DISTINCT movement_pattern ORDER BY movement_pattern) FILTER (WHERE movement_pattern IS NOT NULL) AS movement_patterns,
       array_agg(DISTINCT difficulty       ORDER BY difficulty)       FILTER (WHERE difficulty IS NOT NULL)       AS difficulties,
       array_agg(DISTINCT lower(mechanic)  ORDER BY lower(mechanic))  FILTER (WHERE mechanic IS NOT NULL)         AS mechanics,
       array_agg(DISTINCT lower(force)     ORDER BY lower(force))     FILTER (WHERE force IS NOT NULL)            AS forces,
       COUNT(*)::int AS total
     FROM exercises
     WHERE deleted_at IS NULL AND archived_at IS NULL
       AND (organization_id IS NULL OR organization_id = $1::uuid)`,
    [orgId]
  );

  const { rows: tagRows } = await db.query(
    `SELECT DISTINCT unnest(tags) AS tag
       FROM exercises
      WHERE deleted_at IS NULL AND tags IS NOT NULL
        AND (organization_id IS NULL OR organization_id = $1::uuid)
      ORDER BY tag LIMIT 200`,
    [orgId]
  );

  return { ...m, tags: tagRows.map((r) => r.tag) };
}

// ── Writes ──────────────────────────────────────────────────────────────────

/** Coerce a request body into column values. Unknown keys are ignored. */
function readPayload(body, { partial = false } = {}) {
  const out = {};
  for (const f of TEXT_FIELDS) {
    if (!partial || Object.prototype.hasOwnProperty.call(body, f)) {
      const v = body[f];
      out[f] = v == null || v === '' ? null : String(v).trim();
    }
  }
  for (const f of INT_FIELDS) {
    if (!partial || Object.prototype.hasOwnProperty.call(body, f)) {
      const n = parseInt(body[f], 10);
      out[f] = Number.isFinite(n) ? n : null;
    }
  }
  for (const f of ARRAY_FIELDS) {
    if (!partial || Object.prototype.hasOwnProperty.call(body, f)) {
      out[f] = toArray(body[f]);
    }
  }
  return out;
}

function validate(payload, { partial = false } = {}) {
  const errors = {};
  if (!partial || payload.name !== undefined) {
    if (!payload.name) errors.name = 'Exercise name is required';
    else if (payload.name.length > 160) errors.name = 'Name must be 160 characters or fewer';
  }
  if (payload.difficulty && !DIFFICULTIES.includes(payload.difficulty)) {
    errors.difficulty = `Difficulty must be one of: ${DIFFICULTIES.join(', ')}`;
  }
  if (payload.muscle_group && !MUSCLE_GROUPS.includes(payload.muscle_group)) {
    errors.muscle_group = `Muscle group must be one of: ${MUSCLE_GROUPS.join(', ')}`;
  }
  for (const f of INT_FIELDS) {
    if (payload[f] != null && (payload[f] < 0 || payload[f] > 10000)) {
      errors[f] = 'Value is out of range';
    }
  }
  return errors;
}

/**
 * Is this name already taken in the scope the unique index covers?
 *
 * Checked before the INSERT so the user gets a field-level message instead of
 * a 500 from a constraint violation — but the index is still the authority,
 * and the route translates 23505 for the race this cannot close.
 */
async function findDuplicateName(db, name, orgId, { excludeId = null } = {}) {
  const { rows } = await db.query(
    `SELECT id, name, slug FROM exercises
      WHERE lower(name) = lower($1)
        AND deleted_at IS NULL
        AND COALESCE(organization_id, '00000000-0000-0000-0000-000000000000'::uuid)
            = COALESCE($2::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
        AND ($3::text IS NULL OR id <> $3)
      LIMIT 1`,
    [name, orgId, excludeId]
  );
  return rows[0] || null;
}

async function create(db, { body, user, orgId }) {
  const payload = readPayload(body);
  const errors = validate(payload);
  if (Object.keys(errors).length) return { errors };

  // A custom exercise always belongs to the studio that made it. Without an
  // org there is nowhere to put it that anyone could read back.
  if (!orgId) {
    return { errors: { _: 'Your account is not attached to a studio, so it cannot own an exercise.' } };
  }

  const dupe = await findDuplicateName(db, payload.name, orgId);
  if (dupe) return { duplicate: dupe };

  const id = randomUUID();
  const slug = await uniqueSlug(db, payload.name);
  const keywords = buildSearchKeywords(payload, payload.search_keywords);

  const cols = [...TEXT_FIELDS, ...INT_FIELDS, 'tags'];
  const values = cols.map((c) => payload[c] ?? null);
  const placeholders = cols.map((_, i) => `$${i + 1}`);

  const { rows } = await db.query(
    `INSERT INTO exercises (${cols.join(', ')}, id, slug, search_keywords,
                            organization_id, visibility, created_by, updated_by)
     VALUES (${placeholders.join(', ')},
             $${cols.length + 1}, $${cols.length + 2}, $${cols.length + 3},
             $${cols.length + 4}, $${cols.length + 5}, $${cols.length + 6}, $${cols.length + 7})
     RETURNING ${DETAIL_COLUMNS.replace(/e\./g, '')}`,
    [...values, id, slug, keywords, orgId,
      body.visibility === 'private' ? 'private' : 'public', user.id, user.id]
  );
  return { exercise: rows[0] };
}

/**
 * Snapshot the row as it is now, then apply the update.
 *
 * The snapshot is written inside the same transaction as the update, so
 * history can never record a version that did not exist, and an update can
 * never happen unrecorded.
 */
async function update(db, id, { body, user, orgId, changeNote = null }) {
  // Accepted either as its own argument or inside the body, because it
  // travels with the form it belongs to. readPayload ignores it, so it never
  // reaches a column.
  const note = changeNote ?? body?.change_note ?? null;
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const { rows: current } = await client.query(
      `SELECT * FROM exercises WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
      [id]
    );
    const existing = current[0];
    const permitted = canModify(user, existing);
    if (!permitted.ok) { await client.query('ROLLBACK'); return { denied: permitted }; }
    // A studio may only edit its own row even if it somehow knows the id.
    if (existing.organization_id !== orgId) {
      await client.query('ROLLBACK');
      return { denied: { ok: false, status: 404, message: 'Exercise not found' } };
    }

    const payload = readPayload(body, { partial: true });
    const errors = validate(payload, { partial: true });
    if (Object.keys(errors).length) { await client.query('ROLLBACK'); return { errors }; }

    if (payload.name && payload.name.toLowerCase() !== existing.name.toLowerCase()) {
      const dupe = await findDuplicateName(client, payload.name, orgId, { excludeId: id });
      if (dupe) { await client.query('ROLLBACK'); return { duplicate: dupe }; }
    }

    await client.query(
      `INSERT INTO exercise_versions (exercise_id, version, snapshot, changed_by, changed_by_name, change_note)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (exercise_id, version) DO NOTHING`,
      [id, existing.version, JSON.stringify(existing), user.id, user.name || null, note]
    );

    const sets = [];
    const params = [];
    for (const [key, value] of Object.entries(payload)) {
      params.push(value);
      sets.push(`${key} = $${params.length}`);
    }

    // Renaming changes the slug, but only when the caller did not pin one —
    // an existing link to the old slug is worth more than a tidy URL, so the
    // old row keeps its slug unless the name actually moved.
    if (payload.name && payload.name !== existing.name) {
      params.push(await uniqueSlug(client, payload.name, { excludeId: id }));
      sets.push(`slug = $${params.length}`);
    }

    const merged = { ...existing, ...payload };
    params.push(buildSearchKeywords(merged, payload.search_keywords ?? existing.search_keywords));
    sets.push(`search_keywords = $${params.length}`);

    if (body.visibility === 'private' || body.visibility === 'public') {
      params.push(body.visibility);
      sets.push(`visibility = $${params.length}`);
    }

    params.push(user.id);
    sets.push(`updated_by = $${params.length}`);
    sets.push('updated_at = NOW()');
    sets.push('version = version + 1');

    params.push(id);
    const { rows } = await client.query(
      `UPDATE exercises SET ${sets.join(', ')} WHERE id = $${params.length}
       RETURNING ${DETAIL_COLUMNS.replace(/e\./g, '')}`,
      params
    );

    await client.query('COMMIT');
    return { exercise: rows[0] };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Copy an exercise into this studio's library.
 *
 * The route out of "I cannot edit a shared library exercise": take a copy,
 * which is yours. Also how a trainer builds a variant without retyping thirty
 * fields.
 */
async function duplicate(db, id, { user, orgId, name }) {
  if (!canCreate(user)) {
    return { denied: { status: 403, message: 'You do not have permission to create exercises' } };
  }
  if (!orgId) {
    return { errors: { _: 'Your account is not attached to a studio, so it cannot own an exercise.' } };
  }

  const { rows } = await db.query(
    `SELECT * FROM exercises
      WHERE id = $1 AND deleted_at IS NULL
        AND (organization_id IS NULL OR organization_id = $2::uuid)`,
    [id, orgId]
  );
  const src = rows[0];
  if (!src) return { denied: { status: 404, message: 'Exercise not found' } };

  let newName = (name && String(name).trim()) || `${src.name} (copy)`;
  // Walk the suffix until the name is free, so duplicating twice does not
  // 409 on the second attempt.
  for (let n = 2; await findDuplicateName(db, newName, orgId); n++) {
    newName = `${src.name} (copy ${n})`;
    if (n > 50) { newName = `${src.name} (copy ${randomUUID().slice(0, 6)})`; break; }
  }

  const cols = [...TEXT_FIELDS, ...INT_FIELDS, 'tags'];
  const values = cols.map((c) => (c === 'name' ? newName : src[c] ?? null));
  const placeholders = cols.map((_, i) => `$${i + 1}`);

  const { rows: created } = await db.query(
    `INSERT INTO exercises (${cols.join(', ')}, id, slug, search_keywords,
                            organization_id, visibility, created_by, updated_by)
     VALUES (${placeholders.join(', ')},
             $${cols.length + 1}, $${cols.length + 2}, $${cols.length + 3},
             $${cols.length + 4}, $${cols.length + 5}, $${cols.length + 6}, $${cols.length + 7})
     RETURNING ${DETAIL_COLUMNS.replace(/e\./g, '')}`,
    [...values, randomUUID(), await uniqueSlug(db, newName),
      buildSearchKeywords({ ...src, name: newName }, src.search_keywords),
      orgId, 'private', user.id, user.id]
  );
  return { exercise: created[0] };
}

/** Archive / restore / soft-delete all share the same ownership check. */
async function setLifecycle(db, id, { user, orgId, action }) {
  const { rows } = await db.query(
    `SELECT * FROM exercises WHERE id = $1 AND deleted_at IS NULL`,
    [id]
  );
  const existing = rows[0];
  const permitted = canModify(user, existing);
  if (!permitted.ok) return { denied: permitted };
  if (existing.organization_id !== orgId) {
    return { denied: { status: 404, message: 'Exercise not found' } };
  }

  const sql = {
    archive: 'UPDATE exercises SET archived_at = NOW(), is_active = false, updated_by = $2, updated_at = NOW() WHERE id = $1',
    restore: 'UPDATE exercises SET archived_at = NULL, is_active = true, updated_by = $2, updated_at = NOW() WHERE id = $1',
    // Never a hard DELETE: workout_exercises and workout_session_exercises
    // reference this row, and a client's programme history must survive the
    // library being tidied.
    delete: 'UPDATE exercises SET deleted_at = NOW(), is_active = false, updated_by = $2, updated_at = NOW() WHERE id = $1',
  }[action];

  await db.query(sql, [id, user.id]);
  return { ok: true };
}

async function versions(db, id) {
  const { rows } = await db.query(
    `SELECT id, version, snapshot, changed_by, changed_by_name, change_note, created_at
       FROM exercise_versions WHERE exercise_id = $1 ORDER BY version DESC LIMIT 100`,
    [id]
  );
  return rows;
}

async function setFavorite(db, { userId, exerciseId, favorite }) {
  if (favorite) {
    await db.query(
      `INSERT INTO exercise_favorites (user_id, exercise_id) VALUES ($1,$2)
       ON CONFLICT DO NOTHING`,
      [userId, exerciseId]
    );
  } else {
    await db.query(
      'DELETE FROM exercise_favorites WHERE user_id = $1 AND exercise_id = $2',
      [userId, exerciseId]
    );
  }
}

/** Bump the recency record. Best-effort: never fails the caller's request. */
async function recordUse(db, { userId, exerciseIds }) {
  const ids = (Array.isArray(exerciseIds) ? exerciseIds : [exerciseIds]).filter(Boolean);
  if (!ids.length) return;
  await db.query(
    `INSERT INTO exercise_recent_uses (user_id, exercise_id, use_count, last_used_at)
     SELECT $1, id, 1, NOW() FROM unnest($2::text[]) AS id
     ON CONFLICT (user_id, exercise_id)
     DO UPDATE SET use_count = exercise_recent_uses.use_count + 1, last_used_at = NOW()`,
    [userId, ids]
  );
}

async function setRelations(db, id, { kind, relatedIds }) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM exercise_relations WHERE exercise_id = $1 AND kind = $2', [id, kind]);
    const ids = (relatedIds || []).filter((r) => r && r !== id);
    for (let i = 0; i < ids.length; i++) {
      await client.query(
        `INSERT INTO exercise_relations (exercise_id, related_id, kind, sort_order)
         VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
        [id, ids[i], kind, i]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  slugify, uniqueSlug, buildSearchKeywords, toArray,
  canCreate, canModify, readPayload, validate, findDuplicateName,
  list, getById, meta, create, update, duplicate, setLifecycle,
  versions, setFavorite, recordUse, setRelations,
  TEXT_FIELDS, INT_FIELDS, ARRAY_FIELDS, DIFFICULTIES, MUSCLE_GROUPS,
};
