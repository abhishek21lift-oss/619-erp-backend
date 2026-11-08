'use strict';
// A client that closes the SSE connection before the response ends must stop
// the provider call. Without this the generation keeps running, burns tokens
// and writes a reply nobody will read.

/** Abort when the response closes early; the normal end-of-response close is ignored. */
function abortOnClose(res) {
  const controller = new AbortController();
  res.on('close', () => { if (!res.writableEnded) controller.abort(); });
  return controller;
}

module.exports = { abortOnClose };
