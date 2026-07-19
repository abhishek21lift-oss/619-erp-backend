// src/routes/uploads.js
// Serves everything saved via lib/fileStorage.js — replaces the old bare
// express.static('/uploads') mount so reads transparently come from R2 in
// production and from local disk in dev, matching wherever saveFile()
// actually wrote the object.
const router = require('express').Router();
const { serveFile } = require('../lib/fileStorage');

const isProd = (process.env.NODE_ENV || 'development') === 'production';

router.get('/*', async (req, res, next) => {
  try {
    const key = decodeURIComponent(req.params[0] || '');
    if (!key || key.includes('..')) return res.status(400).json({ error: 'Invalid path' });
    await serveFile(key, res, { maxAgeSeconds: isProd ? 7 * 24 * 60 * 60 : 0 });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
