import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, lstat, unlink } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createSession, type CellResult } from './session.js';

type Request = { code: string; cdp?: string } | { close: true };
const idleMs = 15 * 60_000;

async function sessionSocket(name: string) {
  const directory = `/tmp/ebrowser-${process.getuid!()}`;
  await mkdir(directory, { mode: 0o700 }).catch(error => {
    if (error.code !== 'EEXIST') throw error;
  });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.uid !== process.getuid!() || (info.mode & 0o077))
    throw new Error(`Expected a private session directory at ${directory}.`);
  const key = createHash('sha256').update(process.cwd()).update('\0').update(name).digest('hex').slice(0, 24);
  return `${directory}/${key}.sock`;
}

function exchange(path: string, request: Request): Promise<CellResult> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    const reader = createInterface({ input: socket });
    let connected = false;
    socket.once('connect', () => {
      connected = true;
      socket.end(JSON.stringify(request) + '\n');
    });
    reader.on('error', error => reject(connected
      ? new Error('Browser session disconnected. Check the page before retrying.', { cause: error })
      : error));
    reader.once('line', line => {
      try { resolve(JSON.parse(line)); } catch (error) { reject(error); }
      socket.destroy();
    });
    reader.once('close', () => reject(new Error('Browser session disconnected. Check the page before retrying.')));
  });
}

function unavailable(error: unknown) {
  return ['ENOENT', 'ECONNREFUSED'].includes((error as NodeJS.ErrnoException).code ?? '');
}

export async function sendCell(name: string, request: Request): Promise<CellResult> {
  const path = await sessionSocket(name);
  try {
    return await exchange(path, request);
  } catch (error) {
    if (!unavailable(error)) throw error;
    if ('close' in request) return { ok: true, output: '' };
  }
  const daemon = spawn(process.execPath, [fileURLToPath(import.meta.url), path], {
    detached: true, stdio: 'ignore',
  });
  daemon.unref();
  for (let attempt = 0; attempt < 100; attempt++) {
    await delay(50);
    try { return await exchange(path, request); } catch (error) {
      if (!unavailable(error)) throw error;
    }
  }
  throw new Error('Could not start the ebrowser background session.');
}

async function serve(path: string) {
  let session: Awaited<ReturnType<typeof createSession>> | undefined;
  let endpoint: string | undefined;
  let idle: NodeJS.Timeout;
  let queue = Promise.resolve();
  let stopping = false;

  async function stop() {
    if (stopping) return;
    stopping = true;
    clearTimeout(idle);
    server.close();
    await session?.close();
  }

  const server = createServer({ allowHalfOpen: true }, socket => {
    socket.on('error', () => socket.destroy());
    const reader = createInterface({ input: socket });
    reader.on('error', () => socket.destroy());
    let received = false;
    reader.once('line', line => {
      received = true;
      clearTimeout(idle);
      queue = queue.then(async () => {
        clearTimeout(idle);
        let result: CellResult;
        try {
          const request = JSON.parse(line) as Request;
          if (stopping) throw new Error('Browser session is closing.');
          if ('close' in request) {
            await stop();
            result = { ok: true, output: '' };
          } else {
            if (session && request.cdp !== undefined && request.cdp !== endpoint)
              throw new Error('Session uses a different browser. Choose another --session or close this one.');
            if (!session) {
              endpoint = request.cdp;
              session = await createSession({ cdp: endpoint });
            }
            result = await session.run(request.code);
          }
        } catch (error) {
          result = { ok: false, output: '', error: String(error) };
        }
        socket.end(JSON.stringify(result) + '\n');
        if (!stopping) idle = setTimeout(() => { void queue.then(stop); }, idleMs);
      });
    });
    reader.once('close', () => { if (!received) socket.end(); });
  });
  function listen() {
    return new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(path, () => { server.off('error', reject); resolve(); });
    });
  }
  try {
    await listen();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
    const before = await lstat(path);
    if (!before.isSocket()) throw error;
    const existing = createConnection(path);
    const listening = await new Promise<boolean>((resolve, reject) => {
      existing.once('connect', () => { existing.end(); resolve(true); });
      existing.once('error', error => unavailable(error) ? resolve(false) : reject(error));
    });
    if (listening) return;
    const current = await lstat(path);
    if (current.ino !== before.ino) return;
    await unlink(path);
    await listen();
  }
  idle = setTimeout(() => { void queue.then(stop); }, idleMs);
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.once(signal, () => { void queue.then(stop); });
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  serve(process.argv[2]).catch(() => { process.exitCode = 1; });
