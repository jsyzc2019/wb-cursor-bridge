import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { mkdtempSync, mkdirSync, symlinkSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

import { NdjsonReader } from '../dist/util/ndjson.js';
import { parseStreamLine, describeTool } from '../dist/cursor/parse.js';
import { isInside, canonical, assertWorkspaceAllowed, splitRoots } from '../dist/util/paths.js';
import { buildArgs, tierArgs, capText, extractNeedInput, NEED_INPUT_MARKER } from '../dist/cursor/cli.js';
import { JobStore } from '../dist/store.js';

/* ------------------------------------------------------------------ paths */

test('isInside: sibling with a shared prefix is NOT inside', () => {
  assert.equal(isInside('/srv/repo-2', '/srv/repo'), false);
  assert.equal(isInside('/srv/repo/sub', '/srv/repo'), true);
  assert.equal(isInside('/srv/repo', '/srv/repo'), true);
});

test('isInside: trailing separator on the root does not change the answer', () => {
  assert.equal(isInside('/srv/repo/a/b', '/srv/repo/'), true);
});

test('canonical: normalises redundant separators and dots', () => {
  assert.equal(canonical('/srv/repo/./src/../src/'), canonical('/srv/repo/src'));
});

test('assertWorkspaceAllowed: rejects paths outside every root', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'wbroot-'));
  const other = mkdtempSync(path.join(os.tmpdir(), 'wbother-'));
  try {
    assert.throws(() => assertWorkspaceAllowed(other, [root]), /outside every configured root/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  }
});

test('assertWorkspaceAllowed: rejects when no roots are configured', () => {
  assert.throws(
    () => assertWorkspaceAllowed('/tmp', []),
    /no workspace roots are configured/,
  );
});

test('assertWorkspaceAllowed: rejects a file that is not a directory', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'wbroot-'));
  const file = path.join(root, 'a.txt');
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  writeFileSync(file, 'x');
  try {
    assert.throws(() => assertWorkspaceAllowed(file, [root]), /is not a directory/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('assertWorkspaceAllowed: rejects NUL bytes and reserved device names', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'wbroot-'));
  try {
    assert.throws(() => assertWorkspaceAllowed(`${root}/a\u0000b`, [root]), /NUL byte/);
    assert.throws(() => assertWorkspaceAllowed(`${root}/CON`, [root]), /reserved device name/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('assertWorkspaceAllowed: rejects 8.3 short names', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'wbroot-'));
  try {
    assert.throws(() => assertWorkspaceAllowed(`${root}/REPO~1`, [root]), /short name/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('assertWorkspaceAllowed: a symlink escaping the root is rejected', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'wbroot-'));
  const secret = mkdtempSync(path.join(os.tmpdir(), 'wbsecret-'));
  const link = path.join(root, 'escape');
  try {
    symlinkSync(secret, link, 'dir');
    // The literal path is inside the root, but the resolved path is not.
    assert.throws(
      () => assertWorkspaceAllowed(link, [root]),
      /resolves to|escapes/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(secret, { recursive: true, force: true });
  }
});

test('assertWorkspaceAllowed: accepts a nested directory inside a root', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'wbroot-'));
  const nested = path.join(root, 'a', 'b');
  mkdirSync(nested, { recursive: true });
  try {
    const resolved = assertWorkspaceAllowed(nested, [root]);
    assert.equal(canonical(resolved), canonical(nested));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('splitRoots: splits on ; and on : only where it is safe', () => {
  assert.deepEqual(splitRoots('/a;/b'), ['/a', '/b']);
  assert.deepEqual(splitRoots('  '), []);
});

/* ----------------------------------------------------------------- ndjson */

test('NdjsonReader: reassembles lines split across chunks', () => {
  const r = new NdjsonReader();
  assert.deepEqual(r.push(Buffer.from('{"a":')), []);
  assert.deepEqual(r.push(Buffer.from('1}\n{"b":2}\n')), ['{"a":1}', '{"b":2}']);
});

test('NdjsonReader: handles CRLF and blank lines', () => {
  const r = new NdjsonReader();
  assert.deepEqual(r.push(Buffer.from('{"a":1}\r\n\n{"b":2}\r\n')), ['{"a":1}', '{"b":2}']);
});

test('NdjsonReader: a line that never ends is bounded, counted, and recoverable', () => {
  const r = new NdjsonReader(64);
  // 1 KiB without a newline: cannot be a valid event, must not accumulate.
  assert.deepEqual(r.push(Buffer.from('x'.repeat(1024))), []);
  assert.equal(r.pending, 0, 'the oversized partial line must be dropped');
  assert.equal(r.droppedLines, 1);
  assert.ok(r.droppedBytes >= 1024);

  // Still inside the oversized line: bytes are skipped, not buffered.
  assert.deepEqual(r.push(Buffer.from('y'.repeat(512))), []);
  assert.equal(r.pending, 0);

  // The line finally ends; the NEXT line must parse normally.
  assert.deepEqual(r.push(Buffer.from('tail\n{"ok":true}\n')), ['{"ok":true}']);
  assert.equal(r.droppedLines, 1, 'one logical line is counted once');
});

test('NdjsonReader: a complete but oversized line is dropped, following lines survive', () => {
  const r = new NdjsonReader(32);
  const out = r.push(Buffer.from(`${'z'.repeat(100)}\n{"ok":1}\n`));
  assert.deepEqual(out, ['{"ok":1}']);
  assert.equal(r.droppedLines, 1);
});

test('NdjsonReader: end() never leaks the remnant of a dropped line', () => {
  const r = new NdjsonReader(16);
  r.push(Buffer.from('w'.repeat(64)));
  assert.deepEqual(r.end(), [], 'the remnant must not be parsed as a line');
  assert.equal(r.pending, 0);
});

test('NdjsonReader: survives a multi-byte character split mid-sequence', () => {
  const r = new NdjsonReader();
  const text = Buffer.from('{"t":"完成"}\n', 'utf8');
  const cut = 8; // lands inside the three-byte CJK character
  assert.deepEqual(r.push(text.subarray(0, cut)), []);
  const out = r.push(text.subarray(cut));
  assert.equal(out.length, 1);
  assert.equal(JSON.parse(out[0]).t, '完成');
});

test('NdjsonReader: end() flushes a trailing partial line', () => {
  const r = new NdjsonReader();
  r.push(Buffer.from('{"a":1}'));
  assert.deepEqual(r.end(), ['{"a":1}']);
  assert.deepEqual(r.end(), []);
});

/* ------------------------------------------------------------------ parse */

test('parseStreamLine: init captures thread id and model', () => {
  const ev = parseStreamLine('{"type":"system","subtype":"init","thread_id":"t1","model":"m"}');
  assert.equal(ev.kind, 'init');
  assert.equal(ev.threadId, 't1');
  assert.equal(ev.model, 'm');
});

test('parseStreamLine: assistant text blocks are joined', () => {
  const ev = parseStreamLine(
    '{"type":"assistant","message":{"content":[{"type":"text","text":"a"},{"type":"text","text":"b"}]}}',
  );
  assert.equal(ev.kind, 'text');
  assert.equal(ev.text, 'ab');
});

test('parseStreamLine: tool calls are normalised to a name and target', () => {
  const ev = parseStreamLine(
    '{"type":"tool_call","tool_call":{"readToolCall":{"args":{"path":"src/a.ts"}}}}',
  );
  assert.equal(ev.kind, 'tool');
  assert.equal(ev.tool, 'read');
  assert.equal(ev.target, 'src/a.ts');
  assert.equal(describeTool(ev), 'read src/a.ts');
});

test('parseStreamLine: result wins over accumulated assistant text', () => {
  const ev = parseStreamLine('{"type":"result","result":"final","thread_id":"t9"}');
  assert.equal(ev.kind, 'result');
  assert.equal(ev.text, 'final');
  assert.equal(ev.threadId, 't9');
});

test('parseStreamLine: error events are flagged', () => {
  const ev = parseStreamLine('{"type":"error","error":"boom"}');
  assert.equal(ev.kind, 'error');
  assert.equal(ev.isError, true);
});

test('parseStreamLine: garbage never throws', () => {
  assert.equal(parseStreamLine(''), null);
  assert.equal(parseStreamLine('not json'), null);
  assert.equal(parseStreamLine('{"broken":'), null);
  assert.equal(parseStreamLine('[1,2,3]'), null);
});

/* -------------------------------------------------------------------- args */

test('tierArgs: consult and plan are read-only, execute forces writes', () => {
  assert.deepEqual(tierArgs('consult'), ['--mode', 'ask']);
  assert.deepEqual(tierArgs('plan'), ['--mode', 'plan']);
  assert.deepEqual(tierArgs('execute'), ['--force']);
});

test('buildArgs: never lets the prompt be interpreted as a flag', () => {
  const cfg = { defaultModel: undefined, extraArgs: [] };
  const args = buildArgs(
    cfg,
    {
      prompt: '--force rm -rf /',
      workspace: '/repo',
      tier: 'execute',
      timeoutSec: 60,
      worktree: false,
    },
    'wt',
  );
  // The prompt is always the final positional argument.
  assert.equal(args[args.length - 1], '--force rm -rf /');
  // And the tier still governs writes, not the prompt text.
  assert.ok(args.includes('--force'));
});

test('buildArgs: bridge-managed worktree suppresses --worktree', () => {
  const args = buildArgs(
    { defaultModel: 'm', extraArgs: [] },
    {
      prompt: 'p',
      workspace: '/repo/.wb/worktrees/wt',
      tier: 'execute',
      timeoutSec: 60,
      worktree: true,
      managedWorktree: '/repo/.wb/worktrees/wt',
    },
    'wt',
  );
  assert.ok(!args.includes('--worktree'));
  assert.ok(args.includes('--model'));
  assert.ok(args.includes('m'));
});

test('capText: truncation never splits a multi-byte character', () => {
  // Each CJK character is 3 bytes in UTF-8, so a 10-byte cap lands mid-character.
  const text = '中文测试内容很长很长';
  const { text: out, truncated } = capText(text, 10);
  assert.equal(truncated, true);
  assert.ok(!out.includes('\ufffd'), `no replacement char expected, got ${JSON.stringify(out)}`);
  // The kept prefix must still be valid, complete characters.
  assert.ok(out.startsWith('中文测'), `expected a clean 3-char prefix, got ${JSON.stringify(out)}`);
});

test('capText: short text passes through unchanged', () => {
  const { text, truncated } = capText('hello', 100);
  assert.equal(text, 'hello');
  assert.equal(truncated, false);
});

test('buildArgs: resume thread is threaded through', () => {
  const args = buildArgs(
    { defaultModel: undefined, extraArgs: [] },
    { prompt: 'p', workspace: '/r', tier: 'execute', timeoutSec: 60, worktree: false, resumeThreadId: 'th-7' },
    'wt',
  );
  assert.deepEqual(
    args.slice(args.indexOf('--resume'), args.indexOf('--resume') + 2),
    ['--resume', 'th-7'],
  );
});

/* -------------------------------------------------------- input-required */

test('extractNeedInput: trailing marker splits question from the answer', () => {
  const text = 'partial answer\nNEED_INPUT: which file should I edit?';
  const { result, needInput } = extractNeedInput(text);
  assert.equal(needInput, 'which file should I edit?');
  assert.equal(result, 'partial answer');
});

test('extractNeedInput: a marker not at the end is ignored', () => {
  const text = 'NEED_INPUT: upfront question\nand then the answer';
  const { result, needInput } = extractNeedInput(text);
  assert.equal(needInput, undefined);
  assert.equal(result, text);
});

test('extractNeedInput: no marker leaves the text untouched', () => {
  const text = 'a normal result with no signal';
  const { result, needInput } = extractNeedInput(text);
  assert.equal(needInput, undefined);
  assert.equal(result, text);
});

test('extractNeedInput: the marker constant is what the parser keys on', () => {
  assert.equal(NEED_INPUT_MARKER, 'NEED_INPUT:');
});

/* ------------------------------------------------------------------- store */

const mkJob = (id, status = 'running') => ({
  id,
  tier: 'execute',
  workspace: '/r',
  prompt: 'p',
  status,
  createdAt: new Date(2026, 0, 1, 0, 0, 0).toISOString(),
  events: [],
  cursor: 0,
});

test('JobStore: marks jobs left running by a crash as orphaned', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wbstore-'));
  try {
    const s1 = new JobStore(dir, { maxJobs: 10, maxEventsPerJob: 100 });
    s1.create(mkJob('a', 'running'));
    s1.create(mkJob('b', 'completed'));
    s1.flushNow();

    const s2 = new JobStore(dir, { maxJobs: 10, maxEventsPerJob: 100 });
    const { orphaned } = s2.load();
    assert.deepEqual(orphaned, ['a']);
    assert.equal(s2.get('a').status, 'orphaned');
    assert.equal(s2.get('b').status, 'completed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('JobStore: a sibling instance writing the index does not erase our jobs', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wbstore-shared-'));
  try {
    const limits = { maxJobs: 10, maxEventsPerJob: 100 };
    const a = new JobStore(dir, limits);
    a.load();
    a.create(mkJob('a1', 'completed'));

    // Second bridge on the same stateDir (one per MCP session, same default
    // directory): it loads, then writes its own job.
    const b = new JobStore(dir, limits);
    b.load();
    b.create(mkJob('b1', 'completed'));

    // A's next write used to clobber the file with only A's jobs.
    a.create(mkJob('a2', 'completed'));

    const onDisk = JSON.parse(readFileSync(path.join(dir, 'index.json'), 'utf8'));
    const ids = onDisk.jobs.map((j) => j.id).sort();
    assert.deepEqual(ids, ['a1', 'a2', 'b1'], 'both histories must survive');
    assert.ok(a.get('b1'), 'the sibling job is adopted into memory too');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('JobStore: a sibling instance does not orphan our running job', async () => {
  const { currentInstanceId } = await import('../dist/util/instance.js');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wbstore-sibling-'));
  try {
    const limits = { maxJobs: 10, maxEventsPerJob: 100 };
    const a = new JobStore(dir, limits, undefined, undefined, currentInstanceId());
    a.load();
    a.create(mkJob('live', 'running'));
    a.flushNow();

    // A second bridge on the same stateDir must not assume our live job crashed.
    const b = new JobStore(dir, limits, undefined, undefined, 'another-instance');
    const { orphaned } = b.load();
    assert.deepEqual(orphaned, [], 'a job owned by a live instance is not an orphan');
    assert.equal(b.get('live').status, 'running');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('JobStore: a job left running by our own crashed process is still orphaned', async () => {
  const { currentInstanceId } = await import('../dist/util/instance.js');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wbstore-restart-'));
  try {
    const limits = { maxJobs: 10, maxEventsPerJob: 100 };
    const id = currentInstanceId();
    const first = new JobStore(dir, limits, undefined, undefined, id);
    first.create(mkJob('crashed', 'running'));
    first.flushNow();

    // Same instance id, fresh process state: nothing is running it any more.
    const restarted = new JobStore(dir, limits, undefined, undefined, id);
    const { orphaned } = restarted.load();
    assert.deepEqual(orphaned, ['crashed']);
    assert.equal(restarted.get('crashed').status, 'orphaned');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('JobStore: a sibling completion is never rolled back to a stale state', async () => {
  const { currentInstanceId } = await import('../dist/util/instance.js');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wbstore-stale-'));
  try {
    const limits = { maxJobs: 10, maxEventsPerJob: 100 };
    const a = new JobStore(dir, limits, undefined, undefined, currentInstanceId());
    a.load();
    a.create(mkJob('j1', 'running'));
    a.flushNow();

    // B loads the running job; it belongs to a live instance, so B must not
    // declare it orphaned.
    const b = new JobStore(dir, limits, undefined, undefined, `${process.pid}-sibling-b`);
    b.load();
    assert.equal(b.get('j1').status, 'running', 'a live sibling job stays running');

    // A finishes it on disk.
    a.jobs.set('j1', mkJob('j1', 'completed'));
    a.persist();

    // B's next write must not resurrect "running" for j1.
    b.persist();
    const onDisk = JSON.parse(readFileSync(path.join(dir, 'index.json'), 'utf8'));
    const j1 = onDisk.jobs.find((j) => j.id === 'j1');
    assert.equal(j1.status, 'completed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('JobStore: evicts oldest finished jobs over the cap, keeps running ones', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wbstore-'));
  try {
    const s = new JobStore(dir, { maxJobs: 2, maxEventsPerJob: 100 });
    s.create(mkJob('old', 'completed'));
    s.create(mkJob('mid', 'completed'));
    s.create(mkJob('live', 'running'));
    s.create(mkJob('new', 'completed'));
    assert.equal(s.get('old'), undefined, 'oldest finished job is evicted');
    assert.ok(s.get('live'), 'a running job is never evicted');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('JobStore: event log is capped and marks truncation', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wbstore-'));
  try {
    const s = new JobStore(dir, { maxJobs: 10, maxEventsPerJob: 10 });
    const job = s.create(mkJob('x'));
    for (let i = 0; i < 25; i += 1) {
      s.appendEvent(job, { ts: new Date().toISOString(), type: 'assistant', text: `e${i}` });
    }
    assert.equal(job.events.length, 10);
    assert.equal(job.droppedEvents, 15);
    assert.equal(s.eventsSince(job, job.cursor - 3).length, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('JobStore: index write is atomic (tmp file is renamed away)', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wbstore-'));
  try {
    const s = new JobStore(dir, { maxJobs: 10, maxEventsPerJob: 100 });
    s.create(mkJob('a'));
    s.flushNow();

    assert.ok(existsSync(path.join(dir, 'index.json')));
    assert.ok(!existsSync(path.join(dir, 'index.json.tmp')));
    const parsed = JSON.parse(readFileSync(path.join(dir, 'index.json'), 'utf8'));
    assert.equal(parsed.jobs.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('JobStore: a job paused in input-required survives restart without being orphaned', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wbstore-'));
  try {
    const s1 = new JobStore(dir, { maxJobs: 10, maxEventsPerJob: 100 });
    s1.create({ ...mkJob('a', 'input-required'), pendingInput: 'which file?' });
    s1.flushNow();

    const s2 = new JobStore(dir, { maxJobs: 10, maxEventsPerJob: 100 });
    const { orphaned } = s2.load();
    assert.deepEqual(orphaned, [], 'input-required is a valid state, not orphaned');
    assert.equal(s2.get('a').status, 'input-required');
    assert.equal(s2.get('a').pendingInput, 'which file?');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('JobStore: logs repeated persist failures', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wbstore-'));
  const errors = [];
  const mockLog = {
    error: (msg, fields) => errors.push({ msg, fields }),
    child: () => mockLog,
    info: () => {},
    warn: () => {},
    debug: () => {},
  };
  try {
    // Make the atomic-write temp target a directory before the first persist,
    // so writeFileSync fails with EISDIR without relying on chmod.
    mkdirSync(path.join(dir, 'index.json.tmp'), { recursive: true });
    const s = new JobStore(dir, { maxJobs: 10, maxEventsPerJob: 100 }, mockLog);
    s.create(mkJob('a'));
    assert.ok(
      errors.some((e) => e.msg === 'index persist failed'),
      'persist failure should be logged',
    );
    assert.equal(errors[0].fields.attempt, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('JobStore: persists events to JSONL when eventLogDir is set', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wbstore-'));
  const eventsDir = mkdtempSync(path.join(os.tmpdir(), 'wbevents-'));
  try {
    const s = new JobStore(dir, { maxJobs: 10, maxEventsPerJob: 100 }, undefined, eventsDir);
    const job = s.create(mkJob('a'));
    s.appendEvent(job, { ts: '2026-01-01T00:00:00.000Z', type: 'start' });
    s.appendEvent(job, { ts: '2026-01-01T00:00:01.000Z', type: 'assistant', text: 'hello' });
    s.appendEvent(job, { ts: '2026-01-01T00:00:02.000Z', type: 'end' });
    await s.waitForEventFlush();

    const file = path.join(eventsDir, 'a', 'events.jsonl');
    assert.ok(existsSync(file), 'events.jsonl should exist');
    const lines = readFileSync(file, 'utf8').trim().split('\n');
    assert.equal(lines.length, 3);
    const parsed = lines.map((l) => JSON.parse(l));
    assert.deepEqual(parsed.map((e) => e.seq), [1, 2, 3]);
    assert.equal(parsed[2].type, 'end');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(eventsDir, { recursive: true, force: true });
  }
});

test('JobStore: event persist failure is logged without throwing', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wbstore-'));
  // Make the events directory a file, so mkdirSync inside flushEvents fails.
  const eventsDir = path.join(dir, 'events-file');
  writeFileSync(eventsDir, 'not-a-directory');
  const errors = [];
  const mockLog = {
    error: (msg, fields) => errors.push({ msg, fields }),
    child: () => mockLog,
    info: () => {},
    warn: () => {},
    debug: () => {},
  };
  try {
    const s = new JobStore(dir, { maxJobs: 10, maxEventsPerJob: 100 }, mockLog, eventsDir);
    const job = s.create(mkJob('a'));
    s.appendEvent(job, { ts: '2026-01-01T00:00:00.000Z', type: 'start' });
    await s.waitForEventFlush();
    assert.ok(
      errors.some((e) => e.msg === 'event persist failed'),
      'event persist failure should be logged',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ----------------------------------------------------------------- logger */

const { Logger } = await import('../dist/logger.js');

/* ---------------------------------------------------------------- version */

const { VERSION } = await import('../dist/version.js');

test('VERSION matches package.json so releases cannot be mismatched', () => {
  const pkg = JSON.parse(
    readFileSync(path.resolve(ROOT, 'package.json'), 'utf8'),
  );
  assert.equal(VERSION, pkg.version);
});

/* ------------------------------------------------------------- artifacts */

const { buildArtifacts, JobManager } = await import('../dist/runner.js');

test('buildArtifacts: models deliverables as A2A-style artifacts', () => {
  const job = {
    id: 'j1',
    changedFiles: ['a.ts', 'b.ts'],
    diffStat: ' 2 files changed',
    patchFile: path.join(os.tmpdir(), 'wb-absent-patch.patch'),
  };
  const arts = buildArtifacts(job);
  const byName = Object.fromEntries(arts.map((a) => [a.name, a]));
  assert.equal(arts.length, 3);
  assert.deepEqual(byName['changedFiles'].parts[0].data, { files: ['a.ts', 'b.ts'] });
  assert.equal(byName['diffStat'].parts[0].text, ' 2 files changed');
  assert.equal(byName['changes.patch'].parts[0].kind, 'file');
  // A missing file yields an artifact without crashing and with undefined bytes.
  assert.equal(byName['changes.patch'].parts[0].file.bytes, undefined);
  assert.equal(byName['changes.patch'].parts[0].file.name, 'changes.patch');
});

test('buildArtifacts: an empty job yields no artifacts', () => {
  assert.deepEqual(buildArtifacts({ id: 'j2' }), []);
});

test('JobManager.view: exposes A2A-style artifacts derived from deliverables', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wbview-'));
  const log = new Logger({ level: 'error', fileDir: dir });
  const cfg = {
    cursorBin: 'agent',
    workspaceRoots: [],
    stateDir: dir,
    defaultTimeoutSec: 900,
    maxTimeoutSec: 3600,
    maxConcurrency: 4,
    forceWorktree: false,
    maxResultBytes: 2 * 1024 * 1024,
    maxEventsPerJob: 2000,
    maxJobs: 100,
    logLevel: 'error',
    adminPort: 0,
    extraArgs: [],
  };
  const mgr = new JobManager(cfg, log);
  const job = {
    id: 'v1', tier: 'execute', workspace: '/r', prompt: 'p',
    status: 'completed', createdAt: new Date().toISOString(),
    events: [], cursor: 0,
    changedFiles: ['x.ts'], diffStat: ' 1 file',
  };
  const v = mgr.view(job);
  assert.ok(Array.isArray(v.artifacts));
  assert.equal(v.artifacts.length, 2);
  assert.ok(v.artifacts.some((a) => a.name === 'changedFiles'));
  assert.ok(v.artifacts.some((a) => a.name === 'diffStat'));
  rmSync(dir, { recursive: true, force: true });
});

/* ----------------------------------------------------------------- config */

const { loadConfig } = await import('../dist/config.js');

/** Run `fn` with a temporary environment, restoring every touched key. */
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

test('loadConfig: a non-numeric env value fails loudly instead of silently using the default', () => {
  // `=15m` used to parse as NaN and be swapped for the 900s default: the
  // operator believed the timeout was 15 minutes while jobs ran for up to 15h.
  withEnv({ CURSOR_BRIDGE_TIMEOUT_SEC: '15m' }, () => {
    assert.throws(() => loadConfig(), /CURSOR_BRIDGE_TIMEOUT_SEC is not a number/);
  });
});

test('loadConfig: valid numeric env values still apply', () => {
  withEnv({ CURSOR_BRIDGE_TIMEOUT_SEC: '120' }, () => {
    assert.equal(loadConfig().defaultTimeoutSec, 120);
  });
});

test('loadConfig: an unknown log level is rejected rather than silently mapped', () => {
  withEnv({ CURSOR_BRIDGE_LOG_LEVEL: 'verbose' }, () => {
    assert.throws(() => loadConfig(), /CURSOR_BRIDGE_LOG_LEVEL/);
  });
});

test('loadConfig: an unrecognised boolean is rejected', () => {
  // `=ture` used to be read as false, silently disabling the feature.
  withEnv({ CURSOR_BRIDGE_FORCE_WORKTREE: 'ture' }, () => {
    assert.throws(() => loadConfig(), /CURSOR_BRIDGE_FORCE_WORKTREE/);
  });
});

test('loadConfig: an unknown A2A protocol version is rejected', () => {
  withEnv({ CURSOR_BRIDGE_A2A_PROTOCOL_VERSION: '2.0' }, () => {
    assert.throws(() => loadConfig(), /CURSOR_BRIDGE_A2A_PROTOCOL_VERSION/);
  });
});

test('loadConfig: wildcard CORS cannot be combined with credentials', () => {
  withEnv(
    { CURSOR_BRIDGE_A2A_CORS_ORIGINS: '*', CURSOR_BRIDGE_A2A_CORS_ALLOW_CREDENTIALS: 'true' },
    () => {
      assert.throws(() => loadConfig(), /wildcard/);
    },
  );
});

test('loadConfig: wildcard CORS alone loads with credentials off', () => {
  withEnv(
    { CURSOR_BRIDGE_A2A_CORS_ORIGINS: '*', CURSOR_BRIDGE_A2A_CORS_ALLOW_CREDENTIALS: undefined },
    () => {
      const cfg = loadConfig();
      assert.deepEqual(cfg.a2aCorsOrigins, ['*']);
      assert.equal(cfg.a2aCorsAllowCredentials, false);
    },
  );
});

test('loadConfig: an out-of-range value names the offending setting', () => {
  const prev = process.env.CURSOR_BRIDGE_MAX_JOBS;
  process.env.CURSOR_BRIDGE_MAX_JOBS = '1';
  try {
    // The message must identify the knob, not just print the bad number.
    assert.throws(() => loadConfig(), /CURSOR_BRIDGE_MAX_JOBS/);
  } finally {
    if (prev === undefined) delete process.env.CURSOR_BRIDGE_MAX_JOBS;
    else process.env.CURSOR_BRIDGE_MAX_JOBS = prev;
  }
});

test('Logger: rotates the active file when it exceeds maxBytes', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wblog-'));
  try {
    const log = new Logger({ level: 'info', fileDir: dir, maxBytes: 200, keep: 2 });
    for (let i = 0; i < 50; i += 1) {
      log.info('line', { n: i });
    }
    const file = path.join(dir, 'bridge.log');
    assert.ok(existsSync(file));
    const stat = readFileSync(file, 'utf8');
    assert.ok(stat.length <= 200, `active log should be under 200 bytes, got ${stat.length}`);
    assert.ok(existsSync(`${file}.1`) || existsSync(`${file}.2`), 'rotated file should exist');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------- artifacts */

const { filePart } = await import('../dist/artifacts.js');

test('artifacts: filePart emits standard name and inlines small files', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wbart-'));
  try {
    const f = path.join(dir, 'a.patch');
    writeFileSync(f, 'hello world');
    const part = filePart(f, 'text/x-diff', 'a.patch');
    assert.equal(part.kind, 'file');
    assert.equal(part.file.name, 'a.patch');
    assert.equal(part.file.mimeType, 'text/x-diff');
    assert.ok(part.file.bytes_inline, 'small file is base64-inlined');
    assert.equal(Buffer.from(part.file.bytes_inline, 'base64').toString(), 'hello world');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('artifacts: filePart tolerates a missing file without throwing', () => {
  const part = filePart(path.join(os.tmpdir(), 'wb-absent-xyz.patch'), 'text/x-diff', 'x.patch');
  assert.equal(part.kind, 'file');
  assert.equal(part.file.bytes, undefined, 'missing file reports undefined bytes');
  assert.equal(part.file.name, 'x.patch');
});

/* --------------------------------------------------------------- compat */

const { toV1Task, toV1Card } = await import('../dist/a2a/compat.js');

test('compat: toV1Task remaps FileContent to the v1.0 field names', () => {
  const v0 = {
    id: 't1',
    contextId: 'c1',
    status: { state: 'completed', timestamp: '2026-01-01T00:00:00Z' },
    artifacts: [
      {
        artifactId: 't1-patch',
        name: 'changes.patch',
        parts: [
          {
            kind: 'file',
            file: {
              name: 'changes.patch',
              mimeType: 'text/x-diff',
              uri: 'http://h:1/a2a/artifacts/t1/changes.patch',
              bytes: 20,
              bytes_inline: 'aGVsbG8=',
            },
          },
        ],
      },
    ],
  };
  const v1 = toV1Task(v0);
  const fp = v1.artifacts[0].parts[0].file;
  assert.equal(fp.filename, 'changes.patch');
  assert.equal(fp.mediaType, 'text/x-diff');
  assert.equal(fp.url, 'http://h:1/a2a/artifacts/t1/changes.patch');
  assert.equal(fp.raw, 'aGVsbG8=');
  assert.equal(fp.bytes, 20, 'numeric bytes survives');
  assert.ok(!('name' in fp), 'legacy name dropped');
  assert.ok(!('uri' in fp), 'legacy uri dropped');
  assert.ok(!('bytes_inline' in fp), 'legacy bytes_inline dropped');
});

test('compat: toV1Card moves protocolVersion into supportedInterfaces', () => {
  const base = {
    schema: 's',
    name: 'n',
    description: 'd',
    url: 'http://h/a2a',
    version: '1.0.0',
    capabilities: {},
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: [],
  };
  const v1 = toV1Card(base, 'http://h/a2a');
  assert.equal(v1.protocolVersion, undefined, 'top-level protocolVersion dropped');
  assert.ok(Array.isArray(v1.supportedInterfaces), 'supportedInterfaces present');
  assert.equal(v1.supportedInterfaces[0].protocolVersion, '1.0');
  assert.deepEqual(v1.extensions, [], 'extensions array present');
  assert.equal(v1.url, 'http://h/a2a', 'other fields carried over');
});

/* --------------------------------------------------------------- instance */

const {
  claimInstanceDir,
  pruneStaleInstanceDirs,
  worktreeRoot,
  OWNER_FILE,
  pidAlive,
} = await import('../dist/util/instance.js');

test('instance: concurrent instances get distinct directories and neither is reclaimed', () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'wbinst-'));
  try {
    const a = claimInstanceDir(stateDir, `a-${process.pid}`);
    const b = claimInstanceDir(stateDir, `b-${process.pid}`);
    assert.notEqual(a, b, 'each instance must own its own container');
    assert.ok(existsSync(path.join(a, OWNER_FILE)));
    // A third bridge starting up runs the startup reclaim; it must leave both
    // live directories alone (this is the bug: it used to delete them all).
    const res = pruneStaleInstanceDirs(stateDir, { selfId: 'a-third-instance' });
    assert.ok(existsSync(a), 'live instance A keeps its worktrees');
    assert.ok(existsSync(b), 'live instance B keeps its worktrees');
    assert.equal(res.removed.length, 0);
    assert.equal(res.peers.length, 2);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('instance: a directory owned by a dead pid is reclaimed', () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'wbinst-dead-'));
  try {
    const dead = claimInstanceDir(stateDir, 'gone');
    mkdirSync(path.join(dead, 'wb-job-1234'), { recursive: true });
    writeFileSync(path.join(dead, 'wb-job-1234', 'f.txt'), 'x');
    const res = pruneStaleInstanceDirs(stateDir, {
      selfId: 'elsewhere',
      isAlive: () => false,
    });
    assert.ok(!existsSync(dead), 'dead instance directory is removed');
    assert.deepEqual(res.removed, [dead]);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('instance: a directory owned by another host is never reclaimed', () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'wbinst-host-'));
  try {
    // owner.json records this machine's hostname; ask the pruner as if we were
    // a different host, which is the cross-machine network-share case.
    const dir = claimInstanceDir(stateDir, 'remote');
    const res = pruneStaleInstanceDirs(stateDir, {
      selfId: 'me',
      hostname: 'some-other-host',
      isAlive: () => false,
    });
    assert.ok(existsSync(dir), 'a foreign pid says nothing about liveness');
    assert.equal(res.removed.length, 0);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('instance: unattributed legacy directories are reclaimed only once stale', () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'wbinst-legacy-'));
  try {
    const root = worktreeRoot(stateDir);
    const oldDir = path.join(root, 'wb-legacy-old');
    const newDir = path.join(root, 'wb-legacy-new');
    for (const dir of [oldDir, newDir]) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, 'leftover.txt'), 'x');
    }
    // Directories written before per-instance layout carry no owner record, so
    // age is the only signal that their bridge is gone.
    const old = new Date(Date.now() - 10 * 60 * 60 * 1000);
    fs.utimesSync(path.join(oldDir, 'leftover.txt'), old, old);
    fs.utimesSync(oldDir, old, old);

    const res = pruneStaleInstanceDirs(stateDir, { selfId: 'me' });
    assert.ok(!existsSync(oldDir), 'a 10h-old unattributed directory is reclaimed');
    assert.ok(existsSync(newDir), 'a fresh unattributed directory is left alone');
    assert.deepEqual(res.unknown, [newDir]);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('instance: pidAlive distinguishes this process from an impossible pid', () => {
  assert.equal(pidAlive(process.pid), true);
  assert.equal(pidAlive(-1), false);
  assert.equal(pidAlive(0), false);
});