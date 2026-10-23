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

if (mode === 'write') {
  // Emulate an implementation change inside the worktree.
  const fs = await import('node:fs');
  const path = await import('node:path');
  fs.writeFileSync(path.join(process.cwd(), 'changed-by-fake.txt'), 'ok\n');
  out({ type: 'tool_call', tool_call: { writeToolCall: { args: { path: 'changed-by-fake.txt' } } } });
}

await sleep(120);
out({ type: 'assistant', message: { content: [{ type: 'text', text: 'analysed ' + process.cwd() }] } });
out({ type: 'tool_call', tool_call: { readToolCall: { args: { path: 'src/index.ts' } } } });
await sleep(80);

let resultText;
if (mode === 'needinput' && !isResume) {
  // A2A input-required signal: the answer plus an open question at the tail.
  resultText =
    'I analysed the repo but need more information.\nNEED_INPUT: which file should I edit?';
} else {
  // A resumed run (or any non-input mode) completes normally.
  resultText = isResume ? 'FAKE_RESULT:resumed' : `FAKE_RESULT:${mode}`;
}
out({ type: 'result', result: resultText, thread_id: threadId });
process.exit(0);