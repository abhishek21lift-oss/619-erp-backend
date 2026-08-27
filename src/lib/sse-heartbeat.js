'use strict';
// src/lib/sse-heartbeat.js
// Sends an SSE comment line on a fixed cadence so a reverse proxy with an idle
// read timeout (nginx's 60s default) never cuts a stream that is still waiting
// for its first byte — e.g. an AI generation waiting on the model's first
// token. Comment lines (': ping') are inert for SSE parsers: browsers and the
// repo's parsers skip non-data lines.

// Returns a stop() function. The timer self-clears once the response is ended,
// destroyed, or a write fails, so an unstopped heartbeat cannot keep a process
// alive or write after end.
function startSseHeartbeat(res, intervalMs = 15000) {
  const timer = setInterval(() => {
    if (res.writableEnded || res.destroyed) return clearInterval(timer);
    try {
      res.write(': ping\n\n');
    } catch {
      clearInterval(timer);
    }
  }, intervalMs);
  return () => clearInterval(timer);
}

module.exports = { startSseHeartbeat };