// src/modules/command-center/collectors/host.collector.js
//
// The VPS itself: CPU, memory, swap, load, uptime and disk — the box every
// container shares. Distinct from `runtime`, which reports ONE Node process.
//
// ── Why this needs no mounts ────────────────────────────────────────────────
//
// COMMAND-CENTER-PLAN.md §2 planned `/proc:/host/proc` and `/sys:/host/sys`
// bind mounts for this. They are not needed for these numbers. The files read
// here are not namespaced by Docker (without lxcfs, which this stack does not
// run): /proc/stat, /proc/meminfo, /proc/loadavg and /proc/uptime inside a
// container report the HOST kernel's counters. And statfs on the container's
// root reports the filesystem that backs Docker's storage — the host disk the
// containers actually fill. So the card works on the live box with no compose
// change. HOST_PROC_DIR / HOST_DISK_PATH exist for the day that stops being
// true (lxcfs, a separate data disk), not because anything needs them today.
//
// What it deliberately does NOT claim: a host process count. /proc/<pid>
// directories ARE namespaced, so counting them inside a container counts the
// container. The thread count from /proc/loadavg is host-wide and is reported
// instead, under that name.

'use strict';

const fs = require('fs');
const path = require('path');
const { STATUS, result, unavailable } = require('../registry');

const NAME = 'host';

/**
 * Thresholds, as fractions. CPU has no critical level: one sample is a moment,
 * and a build or a burst of traffic legitimately pins it. Memory and disk do,
 * because running out of either takes the platform down.
 */
const THRESHOLDS = Object.freeze({
  cpu: { warning: 0.9 },
  memory: { warning: 0.85, critical: 0.95 },
  disk: { warning: 0.85, critical: 0.95 },
  // 1-minute load per core.
  load: { warning: 2 },
});

const procDir = () => process.env.HOST_PROC_DIR || '/proc';
const diskPath = () => process.env.HOST_DISK_PATH || '/';

/** First CPU-time sample to compare against; kept between collections. */
let previousCpu = null;

function readProc(file) {
  return fs.promises.readFile(path.join(procDir(), file), 'utf8');
}

/** Aggregate CPU times from the `cpu ` line, and the number of cpuN lines. */
function parseStat(text) {
  const lines = text.split('\n');
  const total = lines.find((l) => l.startsWith('cpu '));
  if (!total) throw new Error('no aggregate cpu line in /proc/stat');
  const v = total.trim().split(/\s+/).slice(1).map(Number);
  // user nice system idle iowait irq softirq steal (guest time is already in user)
  const [user, nice, system, idle, iowait = 0, irq = 0, softirq = 0, steal = 0] = v;
  return {
    idle: idle + iowait,
    total: user + nice + system + idle + iowait + irq + softirq + steal,
    steal,
    cores: lines.filter((l) => /^cpu\d+\s/.test(l)).length || null,
  };
}

/** Busy and steal fractions between two samples; null when no time has passed. */
function cpuDelta(a, b) {
  const total = b.total - a.total;
  if (!(total > 0)) return { busy: null, steal: null };
  const clamp = (x) => Math.min(1, Math.max(0, x));
  return { busy: clamp(1 - (b.idle - a.idle) / total), steal: clamp((b.steal - a.steal) / total) };
}

function parseMeminfo(text) {
  const kb = {};
  for (const line of text.split('\n')) {
    const m = /^(\w+):\s+(\d+)\s*kB/.exec(line);
    if (m) kb[m[1]] = Number(m[2]) * 1024;
  }
  return kb;
}

function parseLoadavg(text) {
  const [one, five, fifteen, threads] = text.trim().split(/\s+/);
  const [running, total] = (threads || '').split('/').map(Number);
  return {
    one: Number(one), five: Number(five), fifteen: Number(fifteen),
    running_threads: Number.isFinite(running) ? running : null,
    total_threads: Number.isFinite(total) ? total : null,
  };
}

const ratio = (used, total) => (total > 0 ? used / total : null);

async function sampleCpu(signal) {
  let base = previousCpu;
  if (!base) {
    // First collection after boot: take a short baseline so the card has a
    // number now instead of a blank until the next tick.
    base = parseStat(await readProc('stat'));
    await new Promise((resolve) => {
      const t = setTimeout(resolve, 250);
      signal?.addEventListener?.('abort', () => { clearTimeout(t); resolve(); }, { once: true });
    });
  }
  const now = parseStat(await readProc('stat'));
  previousCpu = now;
  return { cores: now.cores, ...cpuDelta(base, now) };
}

async function collect({ signal } = {}) {
  let cpu; let mem; let load; let uptime;
  try {
    [cpu, mem, load, uptime] = await Promise.all([
      sampleCpu(signal),
      readProc('meminfo').then(parseMeminfo),
      readProc('loadavg').then(parseLoadavg),
      readProc('uptime').then((t) => Number(t.trim().split(/\s+/)[0])),
    ]);
  } catch (err) {
    // Not Linux, or /proc not where HOST_PROC_DIR says: a gap, not an outage.
    return unavailable(NAME, `Host metrics unreadable (${err.code || err.message}) — expected ${procDir()} to be a Linux procfs`);
  }

  let disk = null;
  try {
    const s = await fs.promises.statfs(diskPath());
    const total = s.blocks * s.bsize;
    const free = s.bavail * s.bsize;
    disk = { path: diskPath(), total_bytes: total, free_bytes: free, used_bytes: total - free, used_ratio: ratio(total - free, total) };
  } catch (err) {
    disk = { path: diskPath(), error: err.code || err.message };
  }

  const memTotal = mem.MemTotal ?? null;
  const memAvailable = mem.MemAvailable ?? mem.MemFree ?? null;
  const swapTotal = mem.SwapTotal ?? 0;
  const swapUsed = swapTotal - (mem.SwapFree ?? 0);

  const data = {
    cpu: {
      cores: cpu.cores,
      busy_ratio: cpu.busy,
      // Time the hypervisor gave to other tenants. On a VPS, a high value means
      // the box is starved by its neighbours, not by this platform.
      steal_ratio: cpu.steal,
    },
    memory: {
      total_bytes: memTotal,
      available_bytes: memAvailable,
      used_bytes: memTotal != null && memAvailable != null ? memTotal - memAvailable : null,
      used_ratio: memTotal != null && memAvailable != null ? ratio(memTotal - memAvailable, memTotal) : null,
    },
    swap: {
      total_bytes: swapTotal,
      used_bytes: swapUsed,
      used_ratio: ratio(swapUsed, swapTotal),
    },
    load,
    load_per_core: cpu.cores ? load.one / cpu.cores : null,
    uptime_seconds: Number.isFinite(uptime) ? uptime : null,
    disk,
    source: `${procDir()} + statfs(${diskPath()})`,
  };

  const problems = [];
  const crit = [];
  const m = data.memory.used_ratio;
  const d = disk?.used_ratio;
  if (m != null && m >= THRESHOLDS.memory.critical) crit.push(`memory ${Math.round(m * 100)}% used`);
  else if (m != null && m >= THRESHOLDS.memory.warning) problems.push(`memory ${Math.round(m * 100)}% used`);
  if (d != null && d >= THRESHOLDS.disk.critical) crit.push(`disk ${Math.round(d * 100)}% full`);
  else if (d != null && d >= THRESHOLDS.disk.warning) problems.push(`disk ${Math.round(d * 100)}% full`);
  if (cpu.busy != null && cpu.busy >= THRESHOLDS.cpu.warning) problems.push(`CPU ${Math.round(cpu.busy * 100)}% busy`);
  if (data.load_per_core != null && data.load_per_core >= THRESHOLDS.load.warning) {
    problems.push(`load ${load.one.toFixed(2)} on ${cpu.cores} core(s)`);
  }

  if (crit.length) return result(NAME, { status: STATUS.CRITICAL, data, reason: [...crit, ...problems].join(' · ') });
  if (problems.length) return result(NAME, { status: STATUS.WARNING, data, reason: problems.join(' · ') });
  return result(NAME, { status: STATUS.HEALTHY, data, reason: null });
}

/** Test hook: forget the previous CPU sample. */
function _reset() { previousCpu = null; }

module.exports = { NAME, collect, THRESHOLDS, parseStat, parseMeminfo, parseLoadavg, cpuDelta, _reset };
