import { start } from 'node:repl';
import type { Domain } from 'node:domain';
import { PassThrough } from 'node:stream';
import { inspect, format } from 'node:util';
import { chromium, errors, type Locator, type Page } from 'playwright-core';
import { observations } from './snapshot.js';

const endpoint = process.argv[2];
const browser = await (endpoint ? chromium.connectOverCDP(endpoint) : chromium.launch()).catch(async error => {
  await new Promise<void>(resolve => process.send?.({ startupError: String(error) }, () => resolve()));
  process.exit(1);
});
const context = endpoint ? browser.contexts()[0] : await browser.newContext();
if (!context) throw new Error('Attached browser has no default context.');
context.setDefaultTimeout(10_000);

const pages = new Map<number, Page>();
const proxies = new WeakMap<Page, Page>();
const rawPages = new WeakMap<Page, Page>();
let current: number | undefined;
let nextId = 0;
const { snapshot, getByRef } = observations();

function wrap(page: Page) {
  let proxy = proxies.get(page);
  if (!proxy) {
    proxy = new Proxy(page, {
      get(target, key) {
        if (key === 'getByRef') return (ref: string) => getByRef(target, ref);
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    proxies.set(page, proxy);
    rawPages.set(proxy, page);
  }
  return proxy;
}

function register(page: Page) {
  for (const [id, known] of pages) if (known === page) return id;
  const id = ++nextId;
  pages.set(id, page);
  page.once('close', () => {
    pages.delete(id);
    if (current === id) current = pages.keys().next().value;
  });
  return id;
}

function lookup(id: number) {
  const page = pages.get(id);
  if (!page) throw new Error(`Unknown tab ${id}`);
  return page;
}

context.on('page', register);
for (const page of context.pages()) register(page);

const sink = new PassThrough();
sink.resume();
const repl = start({ input: new PassThrough(), output: sink, terminal: false, prompt: '' });
let output: string[] = [];
const log = (...args: unknown[]) => { output.push(format(...args)); };
Object.assign(repl.context, {
  console: { log, info: log, warn: log, error: log, dir: log },
  async openTab(url: string) {
    const page = await context.newPage();
    const id = register(page);
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      current = id;
      return wrap(page);
    } catch (error) {
      await page.close().catch(() => {});
      throw error;
    }
  },
  useTab(id: number) {
    const page = lookup(id);
    current = id;
    return wrap(page);
  },
  closeTab: (id: number) => lookup(id).close(),
  snapshot: (page: Page, options?: Parameters<typeof snapshot>[1]) =>
    snapshot(rawPages.get(page) ?? page, options),
  async observeAfter(action: () => unknown, {
    waitFor, state = 'visible', timeout = 2500, ...options
  }: NonNullable<Parameters<typeof snapshot>[1]> & {
    waitFor: Locator;
    state?: 'attached' | 'detached' | 'visible' | 'hidden';
    timeout?: number;
  }) {
    await action();
    let reached = true;
    try {
      await waitFor.waitFor({ state, timeout });
    } catch (error) {
      if (!(error instanceof errors.TimeoutError)) throw error;
      reached = false;
    }
    if (current === undefined) throw new Error('No active tab to observe.');
    const result = await snapshot(lookup(current), options);
    return {
      reached,
      observation: reached ? result.diff ?? result.tree : result.tree,
    };
  },
});
Object.defineProperties(repl.context, {
  page: { get: () => current === undefined ? undefined : wrap(lookup(current)) },
  tabs: { get: () => [...pages].map(([id, page]) => ({ id, url: page.url(), active: id === current })) },
});

process.on('message', (message: { code: string } | { close: true }) => {
  if ('close' in message) {
    repl.close();
    void browser.close().finally(() => process.disconnect());
    return;
  }
  output = [];
  // Node's default REPL evaluator emits synchronous throws on its domain.
  const domain = (repl as typeof repl & { _domain: Domain })._domain;
  let finished = false;
  const finish = (error: Error | null, value?: unknown) => {
    if (finished) return;
    finished = true;
    domain.removeListener('error', finish);
    if (!error && value !== undefined) {
      const page = rawPages.get(value as Page);
      output.push(page ? `Page ${page.url()}` : inspect(value, { depth: 3 }));
    }
    process.send?.({ ok: !error, output: output.join('\n'), ...(error && { error: String(error) }) });
  };
  domain.prependOnceListener('error', finish);
  repl.eval(message.code + '\n', repl.context, 'cell.js', finish);
});
process.send?.({ ready: true });
