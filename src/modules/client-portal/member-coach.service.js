'use strict';
// The member's coach, as the coach presents themselves.
//
// Everything here is what the trainer wrote on their own My Profile page
// (user_profiles), read for one of their clients. It is a public face, so the
// shape is an allow-list: no email, no phone, no credential numbers, no
// notification settings, no MFA columns. A column added to user_profiles
// later does not reach a member unless it is named below.
//
// Which trainer: the user account linked to the client's assigned trainer,
// else the studio's own trainer account. A studio has exactly one live
// trainer account (migration 208), so the fallback is the same person the
// member's dashboard already names.

const credentials = require('../../lib/credentials');
const profileFields = require('../../lib/profileFields');

const arr = (v) => (Array.isArray(v) ? v : []);

/** A stored `/uploads/...` path, or a full URL, or null. Never ''. */
const url = (v) => (v ? String(v) : null);

async function coachFor(db, { clientId, orgId }) {
  const params = [clientId];
  let orgSql = '';
  if (orgId) { params.push(orgId); orgSql = ` AND c.organization_id = $${params.length}`; }

  const { rows } = await db.query(
    `SELECT u.name, p.avatar_url, p.cover_url, p.designation, p.job_title,
            p.experience_since, p.bio, p.philosophy, p.training_style, p.location,
            p.specialisations, p.certifications, p.languages, p.coaching_modes,
            p.previous_gyms, p.education, p.achievements, p.working_hours,
            o.name AS studio_name, o.logo_url AS studio_logo
       FROM pt_clients c
       JOIN LATERAL (
         SELECT su.id, su.name
           FROM users su
          WHERE su.organization_id = c.organization_id AND su.role = 'trainer'
            AND su.deleted_at IS NULL
          ORDER BY (c.trainer_id IS NOT NULL AND su.trainer_id = c.trainer_id) DESC, su.created_at
          LIMIT 1
       ) u ON TRUE
       LEFT JOIN user_profiles p ON p.user_id = u.id
       LEFT JOIN organizations o ON o.id = c.organization_id
      WHERE c.id = $1 AND c.deleted_at IS NULL${orgSql}`,
    params
  );
  return rows[0] ? present(rows[0]) : null;
}

function present(row) {
  const since = row.experience_since
    ? new Date(row.experience_since).toISOString().slice(0, 10) : null;
  // Lapsed certificates are left out: to a member, a certificate on a coach's
  // profile is a claim that they are qualified now. The trainer still sees
  // every one, with its status, on their own page.
  const certifications = credentials.presentCertifications(row.certifications)
    .filter((c) => c.status !== 'expired' && c.name)
    .map((c) => ({ id: c.id, name: c.name, issuer: c.issuer || '', expires_on: c.expires_on || null, status: c.status }));
  const hours = (row.working_hours && typeof row.working_hours === 'object'
    && !Array.isArray(row.working_hours)) ? row.working_hours : {};

  return {
    name: row.name || '',
    photo_url: url(row.avatar_url),
    cover_url: url(row.cover_url),
    designation: row.designation || '',
    job_title: row.job_title || '',
    years_experience: credentials.yearsOfExperience(since),
    location: row.location || '',
    bio: row.bio || '',
    philosophy: row.philosophy || '',
    training_style: row.training_style || '',
    specialisations: arr(row.specialisations),
    languages: arr(row.languages),
    coaching_modes: arr(row.coaching_modes),
    certifications,
    achievements: arr(row.achievements).map((a) => ({
      id: a.id, title: a.title, kind: a.kind, issuer: a.issuer || '', year: a.year ?? null, detail: a.detail || '',
    })),
    education: arr(row.education).map((e) => ({
      id: e.id, institution: e.institution, degree: e.degree || '', field: e.field || '', year: e.year ?? null,
    })),
    previous_gyms: arr(row.previous_gyms).map((g) => ({
      id: g.id, name: g.name, role: g.role || '', from: g.from || null, to: g.to || null,
    })),
    working_hours: hours,
    weekly_minutes: profileFields.weeklyMinutes(hours),
    studio_name: row.studio_name || null,
    studio_logo: url(row.studio_logo),
  };
}

module.exports = { coachFor, present };
