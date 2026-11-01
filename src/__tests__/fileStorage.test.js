// saveFileFromPath is the disk-backed sibling of saveFile: multer writes a
// large upload to a temp file so it is never held in a Buffer, and this moves
// it into uploads/ (or streams it to R2) and records the size.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');

jest.mock('../lib/storageLedger', () => ({ record: jest.fn(), recordDelete: jest.fn() }));

const storageLedger = require('../lib/storageLedger');
const fileStorage = require('../lib/fileStorage');

const UPLOADS_ROOT = path.join(__dirname, '..', '..', 'uploads');

describe('saveFileFromPath (local disk)', () => {
  const category = `test-${randomUUID()}`;
  const body = Buffer.from('ftyp-isom-bytes');
  let source;

  beforeEach(() => {
    // Force the disk branch; a developer machine with R2 env would otherwise
    // try to reach Cloudflare.
    delete process.env.R2_ACCOUNT_ID;
    delete process.env.R2_ACCESS_KEY_ID;
    delete process.env.R2_SECRET_ACCESS_KEY;
    storageLedger.record.mockClear();
    source = path.join(os.tmpdir(), `mpts-${randomUUID()}.mp4`);
    fs.writeFileSync(source, body);
  });

  afterEach(() => {
    fs.rmSync(source, { force: true });
    fs.rmSync(path.join(UPLOADS_ROOT, category), { recursive: true, force: true });
  });

  it('moves the temp file into uploads and records its size', async () => {
    const url = await fileStorage.saveFileFromPath(
      category, 'clip.mp4', source, 'video/mp4', { organizationId: 'org-1', uploadedBy: 'usr-1' },
    );

    expect(url).toBe(`/uploads/${category}/clip.mp4`);
    expect(fs.existsSync(source)).toBe(false);
    expect(fs.readFileSync(path.join(UPLOADS_ROOT, category, 'clip.mp4'))).toEqual(body);
    expect(storageLedger.record).toHaveBeenCalledWith({
      key: `${category}/clip.mp4`,
      bytes: body.length,
      category,
      contentType: 'video/mp4',
      organizationId: 'org-1',
      uploadedBy: 'usr-1',
    });
  });
});
