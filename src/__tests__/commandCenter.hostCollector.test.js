'use strict';
// The VPS card: CPU, memory, swap, load, uptime and disk from /proc + statfs.
//
// A fake procfs in a temp directory (HOST_PROC_DIR) makes every number exact,
// so each threshold is tested at its edge rather than against whatever the
// test machine happens to be doing.

const fs = require('fs');
const os = require('os');
const path = require('path');

jest.mock('../lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const host = require('../modules/command-center/collectors/host.collector');
const { STATUS } = require('../modules/command-center/registry');

const GiB = 1024 ** 3;
let dir;

/** cpu line fields: user nice system idle iowait irq softirq steal */
function writeProc({ cpu = [100, 0, 100, 800, 0, 0, 0, 0], cores = 2, memTotalKb = 4 * 1024 * 1024, memAvailKb = 3 * 1024 * 1024,
  swapTotalKb = 0, swapFreeKb = 0, loadavg = '0.50 0.40 0.30 2/300 1234', uptime = '3600.5 7000.0' } = {}) {
  const coreLines = Array.from({ length: cores }, (_, i) => `cpu${i} 1 0 1 1 0 0 0 0 0 0`).join('\n');
  fs.writeFileSync(path.join(dir, 'stat'), `cpu  ${cpu.join(' ')} 0 0\n${coreLines}\nintr 1\n`);
  fs.writeFileSync(path.join(dir, 'meminfo'),
    `MemTotal: ${memTotalKb} kB\nMemFree: 1 kB\nMemAvailable: ${memAvailKb} kB\nSwapTotal: ${swapTotalKb} kB\nSwapFree: ${swapFreeKb} kB\n`);
  fs.writeFileSync(path.join(dir, 'loadavg'), `${loadavg}\n`);
  fs.writeFileSync(path.join(dir, 'uptime'), `${uptime}\n`);
}

function mockDisk(usedRatio) {
  const blocks = 1000;
  jest.spyOn(fs.promises, 'statfs').mockResolvedValue({ bsize: 4096, blocks, bavail: Math.round(blocks * (1 - usedRatio)) });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hostproc-'));
  process.env.HOST_PROC_DIR = dir;
  host._reset();
  mockDisk(0.5);
});

afterEach(() => {
  jest.restoreAllMocks();
  delete process.env.HOST_PROC_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('parsing', () => {
  test('/proc/stat: aggregate times, steal, and the core count', () => {
    const s = host.parseStat('cpu  10 2 3 80 5 0 0 4 0 0\ncpu0 1\ncpu1 1\ncpu2 1\nintr 9\n');
    expect(s).toEqual({ idle: 85, total: 104, steal: 4, cores: 3 });
  });

  test('CPU busy and steal come from the DELTA between samples, not the totals since boot', () => {
    const a = { idle: 800, total: 1000, steal: 0 };
    const b = { idle: 850, total: 1100, steal: 10 }; // 100 ticks: 50 idle, 10 stolen
    expect(host.cpuDelta(a, b)).toEqual({ busy: 0.5, steal: 0.1 });
    expect(host.cpuDelta(a, a)).toEqual({ busy: null, steal: null });
  });

  test('/proc/loadavg includes the host-wide thread counts', () => {
    expect(host.parseLoadavg('1.5 1.0 0.5 3/412 999')).toEqual({
      one: 1.5, five: 1, fifteen: 0.5, running_threads: 3, total_threads: 412,
    });
  });
});

describe('the card', () => {
  test('a quiet box is healthy and every number is reported', async () => {
    writeProc();
    const card = await host.collect();

    expect(card.status).toBe(STATUS.HEALTHY);
    expect(card.data.cpu.cores).toBe(2);
    expect(card.data.memory.total_bytes).toBe(4 * GiB);
    expect(card.data.memory.used_bytes).toBe(1 * GiB);
    expect(card.data.memory.used_ratio).toBeCloseTo(0.25);
    expect(card.data.load.one).toBe(0.5);
    expect(card.data.load_per_core).toBeCloseTo(0.25);
    expect(card.data.uptime_seconds).toBeCloseTo(3600.5);
    expect(card.data.disk.used_ratio).toBeCloseTo(0.5);
  });

  test('memory at 85% warns and at 95% is critical', async () => {
    writeProc({ memTotalKb: 100 * 1024, memAvailKb: 15 * 1024 });
    expect((await host.collect()).status).toBe(STATUS.WARNING);

    writeProc({ memTotalKb: 100 * 1024, memAvailKb: 4 * 1024 });
    const card = await host.collect();
    expect(card.status).toBe(STATUS.CRITICAL);
    expect(card.reason).toMatch(/memory 96% used/);
  });

  test('a disk at 95% is critical — running out of disk takes the platform down', async () => {
    writeProc();
    mockDisk(0.96);
    const card = await host.collect();
    expect(card.status).toBe(STATUS.CRITICAL);
    expect(card.reason).toMatch(/disk 96% full/);
  });

  test('a busy CPU only ever warns: one sample is a moment, not an outage', async () => {
    writeProc({ cpu: [0, 0, 0, 1000, 0, 0, 0, 0] });
    await host.collect(); // baseline
    writeProc({ cpu: [990, 0, 0, 1010, 0, 0, 0, 0] }); // 1000 ticks: 990 busy
    const card = await host.collect();
    expect(card.data.cpu.busy_ratio).toBeCloseTo(0.99);
    expect(card.status).toBe(STATUS.WARNING);
  });

  test('load above 2 per core warns', async () => {
    writeProc({ cores: 2, loadavg: '4.40 3.00 2.00 9/300 1' });
    const card = await host.collect();
    expect(card.status).toBe(STATUS.WARNING);
    expect(card.reason).toMatch(/load 4\.40 on 2 core/);
  });

  test('no procfs is UNAVAILABLE (a gap in observability), not CRITICAL', async () => {
    process.env.HOST_PROC_DIR = path.join(dir, 'missing');
    const card = await host.collect();
    expect(card.status).toBe(STATUS.UNAVAILABLE);
    expect(card.reason).toMatch(/unreadable/i);
  });

  test('an unreadable disk does not hide the rest of the card', async () => {
    writeProc();
    fs.promises.statfs.mockRejectedValueOnce(Object.assign(new Error('nope'), { code: 'EACCES' }));
    const card = await host.collect();
    expect(card.status).toBe(STATUS.HEALTHY);
    expect(card.data.disk.error).toBe('EACCES');
    expect(card.data.memory.used_ratio).toBeCloseTo(0.25);
  });
});
