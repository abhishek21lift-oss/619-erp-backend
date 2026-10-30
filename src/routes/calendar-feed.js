'use strict';
// Read-only calendar feed for one trainer. Mounted unauthenticated at
// /api/public, because a calendar client cannot send a login form.
//
// The 32-byte token IS the credential. It is minted once, only shown to the
// trainer, and never rotated by a settings update. It can be revoked by
// clearing the row's token manually; a rotation endpoint can come later if
// anyone asks.
//
// Times are emitted as floating local values (DTSTART:20261102T070000, no Z).
// The stored time is the trainer's IST wall clock, so that is exactly what a
// calendar should display — converting it to UTC would move every session.

const router = require('express').Router();
const { settingsByToken, feedSessions } = require('../modules/pt-os/availability.repository');

const TOKEN_RE = /^[0-9a-f]{64}$/;

const escapeIcs = (value) => String(value ?? '')
  .replace(/\\/g, '\\\\')
  .replace(/;/g, '\\;')
  .replace(/,/g, '\\,')
  .replace(/\r?\n/g, '\\n');

const stamp = (date, time) => `${String(date).replace(/-/g, '')}T${String(time).replace(':', '')}00`;

const dtstamp = () => `${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')}`;

router.get('/calendar/:token.ics', async (req, res, next) => {
  try {
    const token = req.params.token;
    res.set('Cache-Control', 'no-store');
    if (!TOKEN_RE.test(token || '')) return res.status(404).type('text/plain').send('Not found');

    const settings = await settingsByToken(token);
    if (!settings) return res.status(404).type('text/plain').send('Not found');

    const sessions = await feedSessions(settings.organization_id, settings.trainer_id);

    const now = dtstamp();
    const lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//MyPTStudio//EN',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
    ];
    for (const s of sessions) {
      lines.push(
        'BEGIN:VEVENT',
        `UID:${escapeIcs(s.id)}@myptstudio`,
        `DTSTAMP:${now}`,
        `DTSTART:${stamp(s.session_date, s.start_time)}`,
      );
      if (s.end_time) lines.push(`DTEND:${stamp(s.session_date, s.end_time)}`);
      lines.push(`SUMMARY:${escapeIcs(s.title || 'PT Session')}`, 'END:VEVENT');
    }
    lines.push('END:VCALENDAR');

    res.set('Content-Type', 'text/calendar; charset=utf-8');
    return res.send(`${lines.join('\r\n')}\r\n`);
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
