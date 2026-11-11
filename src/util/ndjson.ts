/**
 * Incremental NDJSON reader.
 *
 * Cursor's `--output-format stream-json` is newline-delimited JSON, but the
 * stream chunk boundaries fall wherever the OS pipe decides. This class turns
 * arbitrary chunks into complete lines and tolerates:
 *  - chunk boundaries mid-UTF8-sequence (decoded with a streaming StringDecoder)
 *  - blank lines and non-JSON noise
 *  - a trailing partial line at end of stream
 *  - a line that never ends (bounded, see below)
 *
 * Memory bound: a partial line is buffered until its newline arrives, so a
 * worker that never emits a newline (buggy, compromised, or writing a huge blob)
 * would otherwise grow the buffer without limit until the whole bridge dies.
 * A line longer than `maxLineBytes` can never be parsed as one JSON event, so it
 * is dropped and the reader skips ahead to the next newline, counting the loss.
 */
import { StringDecoder } from 'node:string_decoder';

/** Default cap for a single NDJSON line: far above any real Cursor event. */
export const DEFAULT_MAX_LINE_BYTES = 8 * 1024 * 1024;

export class NdjsonReader {
  private decoder = new StringDecoder('utf8');
  private buffer = '';
  /** True while skipping the remainder of an oversized line. */
  private discarding = false;
  private dropped = 0;
  private droppedChars = 0;

  constructor(private readonly maxLineBytes: number = DEFAULT_MAX_LINE_BYTES) {}

  /** Feed a Buffer, get back the complete lines contained in it. */
  push(chunk: Buffer): string[] {
    const out: string[] = [];
    let text = this.decoder.write(chunk);

    if (this.discarding) {
      const nl = text.indexOf('\n');
      if (nl < 0) {
        this.droppedChars += text.length;
        return out;
      }
      this.droppedChars += nl;
      text = text.slice(nl + 1);
      this.discarding = false;
    }

    this.buffer += text;
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).replace(/\r$/, '');
      this.buffer = this.buffer.slice(idx + 1);
      if (line.length > this.maxLineBytes) {
        this.dropped += 1;
        this.droppedChars += line.length;
        continue;
      }
      if (line.trim().length > 0) out.push(line);
    }

    // A partial line already past the cap can never become a valid event.
    if (this.buffer.length > this.maxLineBytes) {
      this.droppedChars += this.buffer.length;
      this.dropped += 1;
      this.buffer = '';
      this.discarding = true;
    }
    return out;
  }

  /** Flush the decoder at end of stream and return any trailing partial line. */
  end(): string[] {
    const rest = this.buffer + this.decoder.end();
    this.buffer = '';
    if (this.discarding) {
      // The oversized line was counted when it was dropped; its remnant is not
      // a line and must never be parsed.
      this.discarding = false;
      this.droppedChars += rest.length;
      return [];
    }
    const line = rest.trim();
    if (line.length > this.maxLineBytes) {
      this.dropped += 1;
      this.droppedChars += line.length;
      return [];
    }
    return line.length > 0 ? [line] : [];
  }

  get pending(): number {
    return this.buffer.length;
  }

  /** Lines discarded because they exceeded `maxLineBytes`. */
  get droppedLines(): number {
    return this.dropped;
  }

  /** Characters discarded along with those lines, for the audit trail. */
  get droppedBytes(): number {
    return this.droppedChars;
  }
}
