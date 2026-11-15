/**
 * P1 contract-compatibility regression: opt-in compact polling view.
 *
 * The switch `CURSOR_BRIDGE_COMPACT_STATUS` defaults to false. Its entire
 * promise is that the default path (and every `since=0` call) stays
 * BYTE-FOR-BYTE identical to v0.6.0. The first test below compares against a
 * golden JSON text generated from the unmodified v0.6.0 dist/, so any drift in
 * field order, presence or whitespace fails immediately.
 *
 * Design doc: wb-cursor-bridge-p1-contract-review.md (section 6.2).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { JobManager } from '../dist/runner.js';
import { Logger } from '../dist/logger.js';
import { toTask } from '../dist/a2a/convert.js';
import { loadConfig } from '../dist/config.js';
import { createDispatcher } from '../dist/tools.js';
import { fixedJob, baseConfig } from './fixtures/p1-fixture.mjs';
import { rmrf } from './tmp.mjs';

/** Frozen v0.6.0 text — exactly what MCP's ok() injects into the prompt. */
const GOLDEN = fs.readFileSync(
  new URL('./fixtures/p1-v060-jobview.golden.json', import.meta.url),
  'utf8',
);

const serialise = (view) => JSON.stringify(view, null, 2);

async function withManager(compactStatus, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wbp1-'));
  try {
    const mgr = new JobManager(
      baseConfig(dir, { compactStatus }),
      new Logger({ level: 'error', fileDir: dir }),
    );
    return await fn(mgr, dir);
  } finally {
    rmrf(dir);
  }
}

/** Isolate loadConfig() from the host's config file / stray env vars. */
function withEnv(vars, fn) {
  const prev = new Map();
  for (const [k, v] of Object.entries(vars)) {
    prev.set(k, process.env[k]);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of prev) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/* ---------------------------------------------- 1. golden / default path */

test('p1: switch off -> JobView is byte-for-byte v0.6.0', async () => {
  await withManager(false, (mgr) => {
    assert.equal(serialise(mgr.view(fixedJob())), GOLDEN);
    assert.equal(serialise(mgr.view(fixedJob(), 0)), GOLDEN);
  });
});

test('p1: switch off -> MCP tools/call text is byte-for-byte v0.6.0', async () => {
  await withManager(false, async (mgr) => {
    mgr.store.create(fixedJob());
    const dispatch = createDispatcher(mgr);
    const result = await dispatch('cursor_status', { jobId: 'p1-golden-job' });
    assert.equal(result.isError, undefined);
    assert.equal(result.content[0].text, GOLDEN,
      'the exact text handed to the upstream model must not change');
  });
});

/* ------------------------------------------- 2. since=0 full-view channel */

test('p1: since=0 always returns the complete view, even with the switch on', async () => {
  const big = { ...fixedJob(), result: 'R'.repeat(4096) };
  await withManager(false, (off) => withManager(true, (on) => {
    assert.equal(serialise(on.view(big, 0)), serialise(off.view(big, 0)));
    assert.equal(serialise(on.view(big)), serialise(off.view(big)));
    assert.equal(serialise(on.view(fixedJob(), 0)), GOLDEN);
    assert.equal(on.view(big, 0).result, big.result);
  }));
});

test('p1: since>0 on a short task is a byte-identical no-op', async () => {
  await withManager(false, (off) => withManager(true, (on) => {
    for (const since of [1, 2, 5]) {
      assert.equal(
        serialise(on.view(fixedJob(), since)),
        serialise(off.view(fixedJob(), since)),
        `since=${since}: the compact switch must not alter a short task`,
      );
    }
    const v = on.view(fixedJob(), 1);
    assert.equal(v.result, 'FAKE_RESULT:ok');
    assert.equal(v.compact, undefined);
    assert.equal(v.omitted, undefined);
  }));
});

/* -------------------------------------------------- 3. compact behaviour */

test('p1: large stable result is omitted on an incremental poll', async () => {
  const job = { ...fixedJob(), result: 'R'.repeat(4096) };
  await withManager(true, (mgr) => {
    const v = mgr.view(job, 1);
    assert.equal(v.compact, true);
    assert.deepEqual(v.omitted, ['result']);
    assert.ok(!Object.prototype.hasOwnProperty.call(v, 'result'),
      'omitted fields must be absent, not empty');
    assert.ok(v.omittedBytes.result > 4096, 'size is the JSON representation');
    assert.match(v.fullView, /since=0/);
    // Actionable / identity fields are never traded away for bytes.
    assert.equal(v.jobId, job.id);
    assert.equal(v.status, 'completed');
    assert.equal(v.cursor, 2);
    assert.equal(v.truncated, false);
    assert.ok(Array.isArray(v.events));
    assert.ok(Array.isArray(v.artifacts));
    assert.equal(v.artifacts.length, 2);
    assert.equal(v.pendingInput, undefined);
  });
});

test('p1: both large result and large artifacts are omitted, flat fields kept', async () => {
  const job = {
    ...fixedJob(),
    result: 'R'.repeat(4096),
    diffStat: 'D'.repeat(4096),
  };
  await withManager(true, (mgr) => {
    const v = mgr.view(job, 2);
    assert.deepEqual(v.omitted, ['result', 'artifacts']);
    assert.ok(!Object.prototype.hasOwnProperty.call(v, 'artifacts'));
    assert.equal(v.diffStat, job.diffStat, 'flat deliverable fields stay');
    assert.equal(v.omittedBytes.artifacts > 4096, true);
  });
});

test('p1: omit threshold is strict and measured on the JSON value', async () => {
  await withManager(true, (mgr) => {
    // jsonBytes counts the surrounding quotes: 1022 chars -> 1024 bytes (not >),
    // 1023 chars -> 1025 bytes (>). This pins the strict `>` boundary.
    const atLimit = mgr.view({ ...fixedJob(), result: 'a'.repeat(1022) }, 1);
    assert.equal(atLimit.omitted, undefined);
    assert.equal(atLimit.result.length, 1022);
    const overLimit = mgr.view({ ...fixedJob(), result: 'a'.repeat(1023) }, 1);
    assert.deepEqual(overLimit.omitted, ['result']);
    assert.equal(overLimit.result, undefined);
  });
});

test('p1: result none -> short -> long and input-required boundaries', async () => {
  await withManager(true, (mgr) => {
    const none = mgr.view({ ...fixedJob(), result: undefined }, 1);
    assert.equal(none.omitted, undefined);
    assert.ok(Object.prototype.hasOwnProperty.call(none, 'result'));

    const short = mgr.view({ ...fixedJob(), result: 'a'.repeat(100) }, 1);
    assert.equal(short.omitted, undefined);
    assert.equal(short.result.length, 100);

    const grown = mgr.view({ ...fixedJob(), result: 'a'.repeat(4096) }, 1);
    assert.deepEqual(grown.omitted, ['result']);

    const paused = {
      ...fixedJob(),
      status: 'input-required',
      pendingInput: 'Which file should I edit?',
      result: 'P'.repeat(4096),
    };
    const v = mgr.view(paused, 2);
    assert.deepEqual(v.omitted, ['result']);
    assert.equal(v.pendingInput, 'Which file should I edit?');
    assert.match(v.next, /cursor_reply/);
    assert.equal(v.status, 'input-required');
    assert.equal(v.events.length, 0, 'since=2 still filters events');
  });
});

test('p1: since=0 recovers the full view after compact polls', async () => {
  const job = { ...fixedJob(), result: 'Z'.repeat(8192) };
  await withManager(true, (mgr) => {
    const first = serialise(mgr.view(job, 0));
    const compact = mgr.view(job, 1);
    assert.equal(compact.compact, true);
    assert.equal(compact.result, undefined);
    const recovered = serialise(mgr.view(job, 0));
    assert.equal(recovered, first);
    assert.equal(JSON.parse(recovered).result, job.result);
    assert.equal(JSON.parse(recovered).compact, undefined);
  });
});

/* -------------------------------------------- 4. no impact on other faces */

test('p1: A2A Task is byte-identical and never carries compact markers', async () => {
  const job = { ...fixedJob(), result: 'A'.repeat(4096) };
  const beforeV03 = JSON.stringify(toTask(job, { a2aVersion: '0.3.0', withHistory: true }));
  const beforeV10 = JSON.stringify(toTask(job, { a2aVersion: '1.0', withHistory: true }));
  await withManager(false, (off) => withManager(true, (on) => {
    off.view(job, 1);
    const compactView = on.view(job, 1);
    assert.equal(compactView.compact, true);
    // view() must not mutate the Job that the A2A converter reads.
    assert.equal(JSON.stringify(toTask(job, { a2aVersion: '0.3.0', withHistory: true })), beforeV03);
    assert.equal(JSON.stringify(toTask(job, { a2aVersion: '1.0', withHistory: true })), beforeV10);
    for (const task of [beforeV03, beforeV10]) {
      const parsed = JSON.parse(task);
      assert.ok(!Object.prototype.hasOwnProperty.call(parsed, 'omitted'));
      assert.ok(!Object.prototype.hasOwnProperty.call(parsed, 'compact'));
    }
  }));
});

test('p1: pre-0.6 client reading fields one by one is unaffected', async () => {
  await withManager(false, (mgr) => {
    const v = mgr.view(fixedJob(), 0);
    const legacy = [
      'jobId', 'status', 'tier', 'workspace', 'exitCode', 'durationMs',
      'createdAt', 'finishedAt', 'result', 'truncated', 'isolation',
      'changedFiles', 'diffStat', 'artifacts', 'droppedEvents', 'events', 'cursor',
    ];
    for (const key of legacy) {
      assert.ok(Object.prototype.hasOwnProperty.call(v, key), `legacy field ${key} is gone`);
    }
    assert.equal(v.result, 'FAKE_RESULT:ok');
    assert.equal(v.artifacts.length, 2);
    assert.equal(v.events.length, 2);
    for (const key of ['omitted', 'omittedBytes', 'fullView', 'compact']) {
      assert.ok(!Object.prototype.hasOwnProperty.call(v, key),
        `new field ${key} must not appear on the default path`);
    }
  });
});

/* ------------------------------------------------------- 5. config switch */

test('p1: CURSOR_BRIDGE_COMPACT_STATUS defaults false and rejects typos', () => {
  const guard = { WB_CURSOR_BRIDGE_CONFIG: '/nonexistent/wb-cursor-bridge.config.json' };
  withEnv({ ...guard, CURSOR_BRIDGE_COMPACT_STATUS: undefined }, () => {
    assert.equal(loadConfig().compactStatus, false);
  });
  for (const value of ['1', 'true', 'YES', 'on']) {
    withEnv({ ...guard, CURSOR_BRIDGE_COMPACT_STATUS: value }, () => {
      assert.equal(loadConfig().compactStatus, true, `${value} must enable it`);
    });
  }
  for (const value of ['0', 'false', 'no', 'off']) {
    withEnv({ ...guard, CURSOR_BRIDGE_COMPACT_STATUS: value }, () => {
      assert.equal(loadConfig().compactStatus, false, `${value} must disable it`);
    });
  }
  withEnv({ ...guard, CURSOR_BRIDGE_COMPACT_STATUS: 'ture' }, () => {
    assert.throws(() => loadConfig(), /CURSOR_BRIDGE_COMPACT_STATUS/);
  });
});
