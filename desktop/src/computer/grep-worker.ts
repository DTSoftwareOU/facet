/** Runs one grep in a worker thread (see runGrep in computer/index.ts). */
import { parentPort, workerData } from 'node:worker_threads';
import { grepSearch, type GrepOptions } from './grep';
import { ToolError } from './util';

void (async () => {
  try {
    const result = await grepSearch(workerData as GrepOptions);
    parentPort!.postMessage({ ok: true, result });
  } catch (e) {
    parentPort!.postMessage({ ok: false, expected: e instanceof ToolError, message: e instanceof Error ? e.message : String(e) });
  }
})();
