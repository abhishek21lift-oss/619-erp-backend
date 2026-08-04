// src/modules/command-center/collectors/runtime.collector.js
//
// The health of THIS Node process: memory, CPU share, event-loop lag, GC.
//
// Distinct from the VPS collector, which reports the host. Both matter and they
// answer different questions — "is the box out of RAM" versus "is this process
// leaking". The brief's memory-leak example ("Backend memory increasing,
// possible leak in notification.service.js") is answered here.
//
// Event-loop lag is the headline number and the reason this file exists rather
// than just reading process.memoryUsage(). CPU percentage tells you the process
// is busy; loop lag tells you requests are already queueing behind it, which is
// what a user actually feels. monitorEventLoopDelay is a libuv-level histogram,
// so it costs effectively nothing and cannot itself be starved by a blocked
// loop the way a setInterval-based sampler can.
'use strict';

const { monitorEventLoopDelay, PerformanceObserver, constants } = require('perf_hooks');
const { STATUS, result } = require('../registry');

const NAME = 'runtime';

// Thresholds. Loop lag is in milliseconds at p99.
//  25ms  — noticeable on a busy endpoint
// 100ms  — the process is visibly stalling
const LAG_WARN_MS = Number(process.env.CC_LAG_WARN_MS) || 25;
const LAG_CRIT_MS = Number(process.env.CC_LAG_CRIT_MS) || 100;
// Heap used as a fraction of heap total.
const HEAP_WARN = 0.80;
const HEAP_CRIT = 0.92;

// ── Event-loop delay histogram ───────────────────────────────────────────────
// Started once at require time and never stopped. resolution:10 means it samples
// every 10ms, which is far finer than the 1s tick that reads it.
const loopDelay = monitorEventLoopDelay({ resolution: 10 });
loopDelay.enable();

// ── GC accounting ────────────────────────────────────────────────────────────
// A rising GC share with flat traffic is the signature of a leak: the process
// spends more and more time collecting and less doing work.
let gcTotalMs = 0;
let gcCount = 0;
let gcObserver = null;
try {
  gcObserver = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      gcTotalMs += entry.duration;
      gcCount += 1;
    }
  });
  gcObserver.observe({ entryTypes: ['gc'] });
  // Without unref the observer's handle keeps Jest alive after the tests pass.
  if (typeof gcObserver.unref === 'function') gcObserver.unref();
} catch {
  // GC entries are not available on every build of Node. Not fatal — the card
  // simply reports gc: null rather than failing.
  gcObserver = null;
}

// CPU share needs two samples to mean anything: cpuUsage() is cumulative
// microseconds, so the interesting figure is the delta over wall time between
// two reads of this collector.
let lastCpu = process.cpuUsage();
let lastCpuAt = Date.now();

function cpuPercentSinceLastCall() {
  const now = Date.now();
  const usage = process.cpuUsage(lastCpu);
  const wallMs = now - lastCpuAt;
  lastCpu = process.cpuUsage();
  lastCpuAt = now;
  // First call after boot has no window to divide by.
  if (wallMs <= 0) return null;
  const cpuMs = (usage.user + usage.system) / 1000;
  // Can exceed 100 on a multi-core box: this is CPU time, not core occupancy.
  return Math.round((cpuMs / wallMs) * 1000) / 10;
}

function bytes(n) { return typeof n === 'number' ? n : null; }

async function collect() {
  const mem = process.memoryUsage();
  const heapRatio = mem.heapTotal > 0 ? mem.heapUsed / mem.heapTotal : 0;

  // Read then reset, so each tick reports the lag for ITS interval rather than
  // an average since boot that flattens every spike into invisibility.
  const lagP50 = loopDelay.percentile(50) / 1e6;
  const lagP99 = loopDelay.percentile(99) / 1e6;
  const lagMax = loopDelay.max / 1e6;
  loopDelay.reset();

  const data = {
    uptime_seconds: Math.round(process.uptime()),
    node_version: process.version,
    pid: process.pid,
    memory: {
      rss_bytes: bytes(mem.rss),
      heap_used_bytes: bytes(mem.heapUsed),
      heap_total_bytes: bytes(mem.heapTotal),
      external_bytes: bytes(mem.external),
      array_buffers_bytes: bytes(mem.arrayBuffers),
      heap_used_ratio: Math.round(heapRatio * 1000) / 1000,
      heap_limit_bytes: constants?.NODE_PERFORMANCE_GC_FLAGS_NO ? null : null,
    },
    cpu_percent: cpuPercentSinceLastCall(),
    event_loop_lag_ms: {
      p50: Math.round(lagP50 * 100) / 100,
      p99: Math.round(lagP99 * 100) / 100,
      max: Math.round(lagMax * 100) / 100,
    },
    gc: gcObserver ? { total_ms: Math.round(gcTotalMs), collections: gcCount } : null,
    // Handles that never close are the other classic leak shape.
    active_handles: typeof process._getActiveHandles === 'function'
      ? process._getActiveHandles().length : null,
    active_requests: typeof process._getActiveRequests === 'function'
      ? process._getActiveRequests().length : null,
  };

  let status = STATUS.HEALTHY;
  let reason = null;
  if (lagP99 >= LAG_CRIT_MS) {
    status = STATUS.CRITICAL;
    reason = `Event-loop lag p99 ${data.event_loop_lag_ms.p99}ms — requests are queueing`;
  } else if (heapRatio >= HEAP_CRIT) {
    status = STATUS.CRITICAL;
    reason = `Heap ${Math.round(heapRatio * 100)}% of allocated — close to out-of-memory`;
  } else if (lagP99 >= LAG_WARN_MS) {
    status = STATUS.WARNING;
    reason = `Event-loop lag p99 ${data.event_loop_lag_ms.p99}ms`;
  } else if (heapRatio >= HEAP_WARN) {
    status = STATUS.WARNING;
    reason = `Heap ${Math.round(heapRatio * 100)}% of allocated`;
  }

  return result(NAME, { status, data, reason });
}

module.exports = { NAME, collect, LAG_WARN_MS, LAG_CRIT_MS, HEAP_WARN, HEAP_CRIT };
