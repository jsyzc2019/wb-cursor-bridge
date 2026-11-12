/**
 * A stand-in for the real `agent` binary.
 *
 * It speaks the same `--output-format stream-json` protocol so the bridge can
 * be exercised end to end without a Cursor account or network access.
 * Behaviour is selected through WB_FAKE_MODE.
 *
 * WB_FAKE_MODE=needinput ends the message with a `NEED_INPUT:` line so the
 * bridge pauses the task in the A2A input-required state; a subsequent
 * `--resume` invocation (used by cursor_reply) completes it instead.
 */
const mode = process.env.WB_FAKE_MODE ?? 'ok';
const isResume = process.argv.includes('--resume');

const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const threadId = 'th-fake-0001';
out({ type: 'system', subtype: 'init', thread_id: threadId, model: 'fake-model' });

if (mode === 'hang') {
  // Never finishes on its own: exercises the timeout + tree-kill path.
  await sleep(10 * 60 * 1000);
}

if (mode === 'crash') {
  process.stderr.write('fake agent: simulated crash\n');
  process.exit(3);
}

/**
 * WB_FAKE_MODE=hold-stdout: leave a detached grandchild holding our stdout open,
 * then exit. `close` never fires on the bridge side, which used to strand the
 * concurrency slot forever (cancel / timeout / shutdown all waited on it).
 */
if (mode === 'hold-stdout') {
  const { spawn } = await import('node:child_process');
  const fs = await import('node:fs');
  const kid = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], {
    stdio: ['ignore', 'inherit', 'inherit'],
    detached: true,
  });
  kid.unref();
  if (process.env.WB_HOLD_PIDFILE) {
    fs.writeFileSync(process.env.WB_HOLD_PIDFILE, String(kid.pid));
  }
  out({ type: 'result', result: 'HOLD_STDOUT', thread_id: threadId });
  await sleep(200);
  process.exit(0);
}

if (mode === 'write') {
  // Emulate an implementation change inside the worktree.
  const fs = await import('node:fs');
  const path = await import('node:path');
  fs.writeFileSync(path.join(process.cwd(), 'changed-by-fake.txt'), 'ok\n');
  out({ type: 'tool_call', tool_call: { writeToolCall: { args: { path: 'changed-by-fake.txt' } } } });
}

/**
 * WB_FAKE_MODE=slow-write: write a file, stay alive long enough for a sibling
 * bridge to boot on the same state directory, then write a second file.
 *
 * Regression probe for multi-instance startup reclaim: if the second bridge
 * deletes this worker's worktree, the `cwd` disappears mid-task and the second
 * write fails, so the job cannot complete.
 */
if (mode === 'slow-write') {
  const fs = await import('node:fs');
  const path = await import('node:path');
  fs.writeFileSync(path.join(process.cwd(), 'slow-first.txt'), 'first\n');
  out({ type: 'tool_call', tool_call: { writeToolCall: { args: { path: 'slow-first.txt' } } } });
  await sleep(2500);
  fs.writeFileSync(path.join(process.cwd(), 'slow-second.txt'), 'second\n');
  out({ type: 'tool_call', tool_call: { writeToolCall: { args: { path: 'slow-second.txt' } } } });
}

/**
 * WB_FAKE_MODE=needinput-write: write a file, THEN ask the question.
 *
 * The resumed pass reports whether that file survived the pause. This is the
 * regression probe for work lost across an input-required round-trip: the
 * bridge must hand the second pass the tree the first pass produced.
 */
let restoredAcrossPause;
if (mode === 'needinput-write') {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const first = path.join(process.cwd(), 'first-pass.txt');
  const bin = path.join(process.cwd(), 'first-pass.bin');
  // A byte with a NUL makes git treat the file as binary; restoring it requires
  // a `--binary` patch.
  const binBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0xff]);
  if (isResume) {
    restoredAcrossPause =
      fs.existsSync(first) &&
      fs.existsSync(bin) &&
      Buffer.compare(fs.readFileSync(bin), binBytes) === 0;
    fs.writeFileSync(path.join(process.cwd(), 'second-pass.txt'), 'from pass two\n');
    out({ type: 'tool_call', tool_call: { readToolCall: { args: { path: 'first-pass.txt' } } } });
  } else {
    fs.writeFileSync(first, 'from pass one\n');
    fs.writeFileSync(bin, binBytes);
    out({ type: 'tool_call', tool_call: { writeToolCall: { args: { path: 'first-pass.txt' } } } });
  }
}

/**
 * WB_FAKE_MODE=flood-needinput: emit a large volume of assistant text and then
 * the pause marker, with no `result` event.
 *
 * The bridge must stop buffering once `maxResultBytes` is reached (a worker that
 * talks for minutes must not grow memory without bound) while still noticing the
 * `NEED_INPUT:` line that arrived after the cap.
 */
if (mode === 'flood-needinput') {
  const chunk = 'x'.repeat(1024);
  for (let i = 0; i < 200; i += 1) {
    out({ type: 'assistant', message: { content: [{ type: 'text', text: chunk }] } });
  }
  out({
    type: 'assistant',
    message: { content: [{ type: 'text', text: '\nNEED_INPUT: which file should I edit?' }] },
  });
  // Let the pipe drain: process.exit() would drop the tail of ~200 KiB of writes
  // and the marker would never reach the bridge (a fixture bug, not a bridge one).
  await sleep(200);
  process.exit(0);
}

await sleep(120);
out({ type: 'assistant', message: { content: [{ type: 'text', text: 'analysed ' + process.cwd() }] } });
out({ type: 'tool_call', tool_call: { readToolCall: { args: { path: 'src/index.ts' } } } });
await sleep(80);

let resultText;
if (mode === 'needinput-write' && !isResume) {
  resultText = 'I started the work but need a decision.\nNEED_INPUT: which file should I edit?';
} else if (mode === 'needinput-write') {
  resultText = `FAKE_RESULT:resumed RESTORED:${restoredAcrossPause ? 'yes' : 'no'}`;
} else if (mode === 'needinput' && !isResume) {
  // A2A input-required signal: the answer plus an open question at the tail.
  resultText =
    'I analysed the repo but need more information.\nNEED_INPUT: which file should I edit?';
} else {
  // A resumed run (or any non-input mode) completes normally.
  resultText = isResume ? 'FAKE_RESULT:resumed' : `FAKE_RESULT:${mode}`;
}
out({ type: 'result', result: resultText, thread_id: threadId });
process.exit(0);