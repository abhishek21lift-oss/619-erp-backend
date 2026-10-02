'use strict';
// The timeout for a call to an outside messaging provider (Twilio, FCM).
//
// Node's fetch waits about five minutes for a response by default, so one
// provider that stops answering held a request or a queue worker for that
// long. Every provider call passes this signal instead: a hung call fails like
// any other provider error and the queue retries it.

const DEFAULT_PROVIDER_TIMEOUT_MS = 10_000;

/** An AbortSignal that fires after PROVIDER_HTTP_TIMEOUT_MS (default 10s). */
function providerSignal() {
  const ms = Number(process.env.PROVIDER_HTTP_TIMEOUT_MS) || DEFAULT_PROVIDER_TIMEOUT_MS;
  return AbortSignal.timeout(ms);
}

module.exports = { providerSignal, DEFAULT_PROVIDER_TIMEOUT_MS };
