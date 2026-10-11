import http from 'node:http';

export interface SseEvent {
  event: string;
  data: string;
}

/** Minimal SSE client: collects events and comment lines. */
export function connect(port: number, token: string) {
  const events: SseEvent[] = [];
  const comments: string[] = [];
  let status = 0;
  let headers: http.IncomingHttpHeaders = {};
  let ended = false;
  const waiters: (() => void)[] = [];
  const notify = () => waiters.splice(0).forEach((w) => w());

  const req = http.request({ host: '127.0.0.1', port, path: '/v1/sync/stream', headers: { authorization: `Bearer ${token}` } });
  req.on('response', (res) => {
    status = res.statusCode ?? 0;
    headers = res.headers;
    let buffer = '';
    res.setEncoding('utf8');
    res.on('data', (chunk: string) => {
      buffer += chunk;
      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        let event = 'message';
        const data: string[] = [];
        for (const line of block.split('\n')) {
          if (line.startsWith(':')) comments.push(line.slice(1).trim());
          else if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data.push(line.slice(5).trim());
        }
        if (data.length > 0) events.push({ event, data: data.join('\n') });
      }
      notify();
    });
    res.on('end', () => {
      ended = true;
      notify();
    });
  });
  req.on('error', () => {
    ended = true;
    notify();
  });
  req.end();

  const waitFor = async (predicate: () => boolean, ms = 3000) => {
    const deadline = Date.now() + ms;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error('timed out waiting for SSE condition');
      await new Promise<void>((resolve) => {
        waiters.push(resolve);
        setTimeout(resolve, 50);
      });
    }
  };

  return {
    events,
    comments,
    get status() {
      return status;
    },
    get headers() {
      return headers;
    },
    get ended() {
      return ended;
    },
    waitFor,
    close: () => req.destroy(),
  };
}
