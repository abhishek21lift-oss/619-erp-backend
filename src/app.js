// src/app.js
// ─────────────────────────────────────────────────────────────────────────────
// DEPRECATED ENTRY POINT — do not use.
//
// The real server is src/server.js.  This file previously existed as a
// thin Express wrapper used only in legacy tests.  It now simply re-exports
// the real app so any stale require('./app') calls continue to work without
// pulling in a second Express instance.
//
// DO NOT add routes here.  Add them in server.js.
// ─────────────────────────────────────────────────────────────────────────────
module.exports = require('./server');
