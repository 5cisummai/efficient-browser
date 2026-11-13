import { fork } from 'node:child_process';
import { once } from 'node:events';

export type CellResult = { ok: boolean; output: string; error?: string };

export async function createSession({ cdp, timeoutMs = 30_000 }: {
  cdp?: string; timeoutMs?: number;
} = {}) {
  const child = fork(new URL('./worker.js', import.meta.url), cdp ? [cdp] : [], {
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    execArgv: [],
  });
  const exited = once(child, 'exit');
  let closed = false;
  function receive<T>(deadline: number): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        closed = true;
        child.kill('SIGKILL');
        reject(new Error('Session timed out and ended. Inspect browser state before retrying an action.'));
      }, deadline);
      function cleanup() {
        clearTimeout(timer);
        child.off('message', onMessage);
        child.off('exit', onExit);
        child.off('error', onError);
      }
      function onMessage(value: unknown) { cleanup(); resolve(value as T); }
      function onError(error: Error) { cleanup(); reject(error); }
      function onExit() { onError(new Error('Browser session exited.')); }
      child.once('message', onMessage);
      child.once('exit', onExit);
      child.once('error', onError);
    });
  }
  void exited.then(() => { closed = true; }, () => { closed = true; });
  const ready = await receive<{ startupError?: string }>(30_000);
  if (ready.startupError) throw new Error(ready.startupError);

  let queue: Promise<unknown> = Promise.resolve();
  return {
    run(code: string): Promise<CellResult> {
      const result = queue.then(async () => {
        if (closed) return { ok: false, output: '', error: 'Browser session ended. Start a new session.' };
        const response = receive<CellResult>(timeoutMs);
        child.send({ code }, error => {
          if (error) child.kill();
        });
        return response.catch(error => ({ ok: false, output: '', error: error.message as string }));
      });
      queue = result;
      return result;
    },
    async close() {
      await queue;
      if (!closed) {
        closed = true;
        child.send({ close: true }, error => { if (error) child.kill(); });
      }
      const timer = setTimeout(() => child.kill('SIGKILL'), 5_000);
      try { await exited; } finally { clearTimeout(timer); }
    },
  };
}
