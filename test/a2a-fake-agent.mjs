#!/usr/bin/env node
/**
 * Self-contained fake Cursor CLI for the A2A integration tests.
 *
 * It speaks the same `--output-format stream-json` protocol the bridge parses,
 * so the A2A HTTP surface can be exercised end to end without a Cursor account.
 * Behaviour is selected by markers in the prompt (the bridge passes the prompt
 * as a CLI argument), which keeps each task deterministic without mutating
 * shared environment state.
 *
 *   NEEDINPUT -> finish in the A2A input-required state
 *   LONGRUN   -> stay busy ~30s (so a cancel can be observed)
 *   WRITEFILE -> write a file into the worktree (so a patch artifact is captured)
 *   (default) -> finish successfully with a known result string
 */
import process from 'node:process';
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const joined = argv.join(' ');
const threadId = 'th-a2a-fake';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const needInput = joined.includes('NEEDINPUT');
const longRun = joined.includes('LONGRUN');
const writeFile = joined.includes('WRITEFILE');
const crash = joined.includes('CRASH');

// Simulate the agent binary blowing up hard before producing any output (e.g. a
// segfault / missing runtime). The bridge must tear down any git worktree it had
// already created rather than leaking it on disk.
if (crash) {
  process.exit(7);
}

out({ type: 'system', subtype: 'init', thread_id: threadId, model: 'fake' });

if (longRun) {
  await sleep(30000);
  out({ type: 'result', result: 'FAKE_RESULT:done', thread_id: threadId });
  process.exit(0);
}

if (writeFile) {
  fs.writeFileSync(path.join(process.cwd(), 'written-by-fake.txt'), 'hello\n');
}

if (needInput) {
  out({ type: 'assistant', message: { content: [{ type: 'text', text: 'let me check first' }] } });
  out({
    type: 'result',
    result: 'I need more information.\nNEED_INPUT: which file should I edit?',
    thread_id: threadId,
  });
  process.exit(0);
}

out({ type: 'assistant', message: { content: [{ type: 'text', text: 'analysed the request' }] } });
out({ type: 'result', result: 'FAKE_RESULT:ok', thread_id: threadId });
process.exit(0);
