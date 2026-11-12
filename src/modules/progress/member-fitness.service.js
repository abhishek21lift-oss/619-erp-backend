'use strict';
// src/modules/progress/member-fitness.service.js
// The signed-in member's read-only fitness-testing view.
//
// Nothing is calculated here beyond the tier label the rest of the product
// already uses: the scores were computed by the trainer's assessment engine
// and are stored on the row. Re-running the formulas for the portal would
// eventually disagree with what the trainer saw.

const repo = require('./member-fitness.repo');
const scoring = require('./fitness-scoring');
const { dbDate } = require('../../lib/appTime');

function num(value) {
  const n = typeof value === 'number' ? value : parseFloat(String(value ?? ''));
  return Number.isFinite(n) ? n : null;
}

function dateOnly(value) {
  return value ? dbDate(value) : null;
}

function normalize(row) {
  const overallMax = num(row.overall_max);
  const overall = num(row.overall_fitness_score);
  return {
    ...row,
    assessment_date: dateOnly(row.assessment_date),
    // A tier describes a complete battery only. A partial row still has a
    // percentage, but calling it "Optimal" would overstate what was measured.
    tier: overallMax === 100 && overall != null ? scoring.tierForScore(overall) : null,
  };
}

async function dashboard(orgId, clientId) {
  const [client, rows, mobility] = await Promise.all([
    repo.client(orgId, clientId),
    repo.assessments(orgId, clientId),
    repo.latestMobility(orgId, clientId),
  ]);

  return {
    client: client ? { name: client.name, gender: client.gender } : null,
    assessments: rows.map(normalize),
    latest_mobility: mobility
      ? { ...mobility, assessment_date: dateOnly(mobility.assessment_date) }
      : null,
  };
}

module.exports = { dashboard };
