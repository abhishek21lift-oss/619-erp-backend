'use strict';
// A studio's trainer sets the studio's logo from My Profile.
//
// organizations.logo_url could only be written from the platform console, so
// a studio's sidebar showed a monogram until an operator stepped in. These pin
// who may write it (the trainer, never a member), which bytes are accepted,
// that the replaced object is cleaned up only when this app stored it, and
// that sessions are refreshed so every account sees the new mark.

const queries = [];
let mockPrevious = null;
jest.mock('../db/pool', () => ({
  query: jest.fn(async (sql, params) => {
    queries.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
    if (/UPDATE organizations SET logo_url/.test(sql)) return { rows: [{ previous: mockPrevious }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  }),
  connect: jest.fn(),
}));
jest.mock('../lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), fatal: jest.fn() }));
jest.mock('../lib/activityLog', () => ({ logActivity: jest.fn() }));
jest.mock('otplib', () => ({ generateSecret: jest.fn(), verifySync: jest.fn() }));
jest.mock('../lib/fileStorage', () => ({
  saveFile: jest.fn(async (cat, name) => `/uploads/${cat}/${name}`),
  deleteFile: jest.fn(async () => {}),
}));

const ORG = 'org-logo-1';
let mockUser = { id: 'usr-t', role: 'trainer', organization_id: ORG };
const mockInvalidate = jest.fn();
jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => { req.user = mockUser; next(); },
  requireTrainer: (...a) => jest.requireActual('../middleware/rbac').requireTrainer(...a),
  invalidateUserCache: (...a) => mockInvalidate(...a),
}));

const express = require('express');
const request = require('supertest');
const { saveFile, deleteFile } = require('../lib/fileStorage');
const { ownedKey } = require('../lib/studioBranding');

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52]);
const GIF = Buffer.from('GIF89a' + '\0'.repeat(10), 'binary');

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/profile', require('../routes/profile'));
  a.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  return a;
}

beforeEach(() => {
  queries.length = 0;
  mockPrevious = null;
  mockUser = { id: 'usr-t', role: 'trainer', organization_id: ORG };
  jest.clearAllMocks();
});

const logoWrites = () => queries.filter((q) => /UPDATE organizations SET logo_url/.test(q.sql));

test('the trainer uploads a logo: stored under org-logos, written to their own studio', async () => {
  const res = await request(app()).post('/api/profile/studio-logo').attach('logo', PNG, { filename: 'l.png', contentType: 'image/png' });
  expect(res.status).toBe(200);
  expect(res.body.logoUrl).toMatch(/^\/uploads\/org-logos\/org-logo-1-\d+\.png$/);
  expect(saveFile).toHaveBeenCalledWith('org-logos', expect.any(String), PNG, 'image/png', expect.objectContaining({ organizationId: ORG }));
  expect(logoWrites()).toHaveLength(1);
  expect(logoWrites()[0].params).toEqual([ORG, res.body.logoUrl]);
  expect(mockInvalidate).toHaveBeenCalledWith();
});

test('a member cannot change the studio logo', async () => {
  mockUser = { id: 'usr-m', role: 'member', organization_id: ORG, pt_client_id: 'c1' };
  const res = await request(app()).post('/api/profile/studio-logo').attach('logo', PNG, { filename: 'l.png', contentType: 'image/png' });
  expect(res.status).toBe(403);
  expect(saveFile).not.toHaveBeenCalled();
  expect(logoWrites()).toHaveLength(0);
  const del = await request(app()).delete('/api/profile/studio-logo');
  expect(del.status).toBe(403);
});

test('bytes that are not a logo image are refused, whatever the header says', async () => {
  const res = await request(app()).post('/api/profile/studio-logo').attach('logo', GIF, { filename: 'l.png', contentType: 'image/png' });
  expect(res.status).toBe(400);
  expect(saveFile).not.toHaveBeenCalled();
});

test('the replaced logo is deleted only when this app stored it', async () => {
  mockPrevious = '/uploads/org-logos/org-logo-1-1.png';
  await request(app()).post('/api/profile/studio-logo').attach('logo', PNG, { filename: 'l.png', contentType: 'image/png' });
  expect(deleteFile).toHaveBeenCalledWith('org-logos/org-logo-1-1.png');

  jest.clearAllMocks();
  mockPrevious = '/logo.png';
  await request(app()).delete('/api/profile/studio-logo');
  expect(deleteFile).not.toHaveBeenCalled();
});

test('removing the logo clears the column', async () => {
  const res = await request(app()).delete('/api/profile/studio-logo');
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ logoUrl: null });
  expect(logoWrites()[0].sql).toMatch(/SET logo_url = NULL/);
  expect(logoWrites()[0].params).toEqual([ORG]);
});

test('ownedKey recognises only objects under org-logos', () => {
  expect(ownedKey('/uploads/org-logos/a.png')).toBe('org-logos/a.png');
  expect(ownedKey('/logo.png')).toBeNull();
  expect(ownedKey('data:image/webp;base64,AAAA')).toBeNull();
  expect(ownedKey('/uploads/profile/a.png')).toBeNull();
  expect(ownedKey(null)).toBeNull();
});
