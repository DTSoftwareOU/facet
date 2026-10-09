/** Server-Sent Events and line streams over fetch (EventSource can't send an Authorization header). */

export interface SseEvent {
  event: string;
  data: string;
  id?: string;
}

function textReader(body: ReadableStream<Uint8Array>): ReadableStreamDefaultReader<string> {
  return body.pipeThrough(new TextDecoderStream() as unknown as TransformStream<Uint8Array, string>).getReader();
}

/**
 * Parses a text/event-stream body. Yields one event per blank-line-terminated block; `data`
 * lines are joined with "\n". Comments (":") are skipped. Aborting [signal] ends the stream.
 */
export async function* readSse(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<SseEvent> {
  const reader = textReader(body);
  let buffer = '';
  let event = '';
  let data: string[] = [];
  let id: string | undefined;
  const onAbort = () => {
    reader.cancel().catch(() => {});
  };
  signal?.addEventListener('abort', onAbort);
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      let nl: number;
      while ((nl = buffer.search(/\r\n|\r|\n/)) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + (buffer[nl] === '\r' && buffer[nl + 1] === '\n' ? 2 : 1));
        if (line === '') {
          if (data.length > 0 || event) yield { event: event || 'message', data: data.join('\n'), id };
          event = '';
          data = [];
          continue;
        }
        if (line.startsWith(':')) continue;
        const colon = line.indexOf(':');
        const field = colon < 0 ? line : line.slice(0, colon);
        let val = colon < 0 ? '' : line.slice(colon + 1);
        if (val.startsWith(' ')) val = val.slice(1);
        if (field === 'event') event = val;
        else if (field === 'data') data.push(val);
        else if (field === 'id') id = val;
      }
    }
    if (data.length > 0) yield { event: event || 'message', data: data.join('\n'), id };
  } finally {
    signal?.removeEventListener('abort', onAbort);
    reader.cancel().catch(() => {});
  }
}

/** Reads newline-delimited text (JSON lines, NDJSON) from a body. */
export async function* readLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = textReader(body);
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, '');
        buffer = buffer.slice(nl + 1);
        yield line;
      }
    }
    if (buffer) yield buffer;
  } finally {
    reader.cancel().catch(() => {});
  }
}
