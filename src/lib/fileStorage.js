// src/lib/fileStorage.js
// Persists uploaded/generated files to Cloudflare R2 (S3-compatible object
// storage) when R2 credentials are configured via env vars, falling back to
// local disk otherwise. Render's filesystem is ephemeral — everything under
// uploads/ is wiped on every deploy/restart — so production must use R2;
// local dev keeps working unmodified without any Cloudflare account.
const fs = require('fs');
const path = require('path');
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');

const UPLOADS_ROOT = path.join(__dirname, '..', '..', 'uploads');
const R2_BUCKET = process.env.R2_BUCKET || 'client-files';

function isR2Configured() {
  return Boolean(process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY);
}

let _s3Client = null;
function getS3Client() {
  if (_s3Client) return _s3Client;
  _s3Client = new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  });
  return _s3Client;
}

/**
 * Persists `buffer` under `<category>/<filename>` and returns the URL the
 * app stores/serves (`/uploads/<category>/<filename>` either way — the
 * `/uploads` route transparently proxies from R2 or disk).
 */
async function saveFile(category, filename, buffer, contentType) {
  const key = `${category}/${filename}`;
  if (isR2Configured()) {
    await getS3Client().send(new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: key,
      Body: buffer,
      ContentType: contentType,
    }));
  } else {
    const dir = path.join(UPLOADS_ROOT, category);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, filename), buffer);
  }
  return `/uploads/${key}`;
}

/**
 * Streams the object at `key` (e.g. "parq/pdf/<id>.pdf") to an Express
 * response, from R2 or disk depending on configuration. Sends 404 if
 * missing; `key` must already be validated by the caller (no "..").
 */
async function serveFile(key, res, { maxAgeSeconds } = {}) {
  if (isR2Configured()) {
    try {
      const result = await getS3Client().send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: key }));
      if (result.ContentType) res.type(result.ContentType);
      if (maxAgeSeconds) res.set('Cache-Control', `public, max-age=${maxAgeSeconds}`);
      result.Body.pipe(res);
    } catch (err) {
      if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) {
        return res.status(404).json({ error: 'Not found' });
      }
      throw err;
    }
    return;
  }
  const filePath = path.join(UPLOADS_ROOT, key);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
  if (maxAgeSeconds) res.set('Cache-Control', `public, max-age=${maxAgeSeconds}`);
  res.sendFile(filePath);
}

module.exports = { isR2Configured, saveFile, serveFile };
