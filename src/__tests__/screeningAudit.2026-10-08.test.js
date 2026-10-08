'use strict';
// Screening audit, 2026-10-08. Each block pins one finding.
//
//   H2  client errors from the body parser and multer used to answer 500
//       "An internal error occurred" — a signed PAR-Q consent over the 100kb
//       body limit failed forever without saying why.
//   C-5 a signature must be a PNG data URL (it was any non-empty string).
//   P-8 Edge was recorded as Chrome on every consent.

const express = require('express');
const request = require('supertest');

jest.mock('../lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const { errorHandler, invalidFileType } = require('../middleware/errorHandler');
const { signatureDataUrl, describeAgent } = require('../lib/signing');
const { mondayOf } = require('../lib/appTime');

function appThrowing(err) {
  const a = express();
  a.post('/x', (_req, _res, next) => next(err));
  a.use(errorHandler);
  return a;
}

describe('H2 — client errors keep their status instead of becoming 500s', () => {
  test('an oversized JSON body is a 413 that says so', async () => {
    const a = express();
    a.use(express.json({ limit: '1kb' }));
    a.post('/x', (_req, res) => res.json({ ok: true }));
    a.use(errorHandler);
    const res = await request(a).post('/x').set('Content-Type', 'application/json')
      .send(JSON.stringify({ sig: 'x'.repeat(5000) }));
    expect(res.status).toBe(413);
    expect(res.body.code).toBe('PAYLOAD_TOO_LARGE');
  });

  test('malformed JSON is a 400, not a 500', async () => {
    const a = express();
    a.use(express.json());
    a.post('/x', (_req, res) => res.json({ ok: true }));
    a.use(errorHandler);
    const res = await request(a).post('/x').set('Content-Type', 'application/json').send('{"oops":');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_JSON');
  });

  test('a file over the upload limit is a 413', async () => {
    const err = Object.assign(new Error('File too large'), { name: 'MulterError', code: 'LIMIT_FILE_SIZE' });
    const res = await request(appThrowing(err)).post('/x');
    expect(res.status).toBe(413);
    expect(res.body).toMatchObject({ error: 'The file is too large.', code: 'LIMIT_FILE_SIZE' });
  });

  test('a rejected file type is a 400 carrying the filter\'s own message', async () => {
    const res = await request(appThrowing(invalidFileType('Only PNG, JPG, or PDF files are allowed'))).post('/x');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Only PNG, JPG, or PDF files are allowed');
  });

  test('a genuine server fault is still a 500', async () => {
    const res = await request(appThrowing(new Error('boom'))).post('/x');
    expect(res.status).toBe(500);
  });
});

describe('C-5 — a signature is a PNG from the signature pad', () => {
  const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

  test('accepts what the pad produces', () => {
    expect(signatureDataUrl.safeParse(PNG).success).toBe(true);
  });

  test.each([
    ['plain text', 'Mina Rao'],
    ['a JPEG', 'data:image/jpeg;base64,/9j/4AAQSkZJRg=='],
    ['an SVG (script-capable)', 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4='],
    ['a PNG header with junk after it', 'data:image/png;base64,AAAA<script>'],
    ['an empty string', ''],
  ])('rejects %s', (_label, value) => {
    expect(signatureDataUrl.safeParse(value).success).toBe(false);
  });
});

describe('P-8 — the signing browser is named correctly', () => {
  test.each([
    ['Edge on Windows', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0', 'Edge', 'desktop'],
    ['Chrome on Android', 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36', 'Chrome', 'mobile'],
    ['Safari on iPhone', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1', 'Safari', 'mobile'],
    ['Chrome on iPad', 'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/129.0 Mobile/15E148 Safari/604.1', 'Chrome', 'mobile'],
    ['Firefox on Linux', 'Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0', 'Firefox', 'desktop'],
    ['Samsung Internet', 'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36', 'Samsung Internet', 'mobile'],
  ])('%s', (_label, ua, browser, device) => {
    expect(describeAgent(ua)).toEqual({ browser, device });
  });

  test('no user agent is a plain desktop browser, not a crash', () => {
    expect(describeAgent(undefined)).toEqual({ browser: 'Browser', device: 'desktop' });
  });
});

describe('weekly check-ins share one definition of a week', () => {
  test.each([
    ['2026-10-05', '2026-10-05'], // Monday stays
    ['2026-10-04', '2026-09-28'], // Sunday belongs to the week that started the Monday before
    ['2026-10-08', '2026-10-05'], // Thursday
    ['2026-03-01', '2026-02-23'], // across a month boundary
  ])('%s → %s', (day, monday) => {
    expect(mondayOf(day)).toBe(monday);
  });
});
