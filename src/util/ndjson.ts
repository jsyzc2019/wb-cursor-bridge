/**
 * Incremental NDJSON reader.
 *
 * Cursor's `--output-format stream-json` is newline-delimited JSON, but the
 * stream chunk boundaries fall wherever the OS pipe decides. This class turns
 * arbitrary chunks into complete lines and tolerates:
 *  - chunk boundaries mid-UTF8-sequence (decoded with a streaming StringDecoder)
 *  - blank lines and non-JSON noise
 *  - a trailing partial line at end of stream
 */
import { StringDecoder } from 'node:string_decoder';

export class NdjsonReader {
  private decoder = new StringDecoder('utf8');
  private buffer = '';

  /** Feed a Buffer, get back the complete lines contained in it. */
  push(chunk: Buffer): string[] {
    this.buffer += this.decoder.write(chunk);
    const out: string[] = [];
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).replace(/\r$/, '');
      this.buffer = this.buffer.slice(idx + 1);
      if (line.trim().length > 0) out.push(line);
    }
    return out;
  }

  /** Flush the decoder at end of stream and return any trailing partial line. */
  end(): string[] {
    const rest = this.buffer + this.decoder.end();
    this.buffer = '';
    const line = rest.trim();
    return line.length > 0 ? [line] : [];
  }

  get pending(): number {
    return this.buffer.length;
  }
}