import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { createSession } from '../dist/session.js';

const url = html => 'data:text/html,' + encodeURIComponent(html);
const fixture = url('<table><tr><td>Ada</td><td><button onclick="this.textContent=\'Saved\'">Edit</button></td></tr><tr><td>Grace</td><td><button>Edit</button></td></tr></table><iframe srcdoc="<button>Inside</button>"></iframe>');

test('JSONL preserves bindings, observes changes and recovers from a cell error', async () => {
  const child = spawn(process.execPath, ['dist/cli.js', 'repl', '--jsonl'], { stdio: ['pipe', 'pipe', 'inherit'] });
  const exit = once(child, 'exit');
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  let id = 0;
  async function cell(code) {
    child.stdin.write(JSON.stringify({ id: ++id, code }) + '\n');
    const reply = JSON.parse((await lines.next()).value);
    assert.equal(reply.id, id);
    return reply;
  }
  try {
    const first = await cell(`await openTab(${JSON.stringify(fixture)}); await page.frameLocator('iframe').getByRole('button').waitFor(); const before = (await snapshot(page)).tree; console.log(before);`);
    assert.equal(first.ok, true, first.error);
    assert.match(first.output, /Ada[\s\S]+Edit[\s\S]+Grace[\s\S]+Edit/);
    assert.match(first.output, /Inside.*:f\d+e\d+/);
    const second = await cell(`const ref = before.match(/button "Edit" \\[ref=([^\\]]+)/)[1]; await page.getByRef(ref).click(); console.log((await snapshot(page)).diff);`);
    assert.equal(second.ok, true, second.error);
    assert.match(second.output, /Saved/);
    assert.match((await cell('throw new Error("fixture error")')).error, /fixture error/);
    assert.match((await cell('await Promise.reject(new Error("async error"))')).error, /async error/);
    const stale = await cell(`await page.goto(${JSON.stringify(url('<button>Edit</button>'))}); await snapshot(page); page.getByRef(ref);`);
    assert.match(stale.error, /Stale snapshot ref/);
    assert.equal((await cell('console.log(tabs.length);')).output, '1');
  } finally {
    child.stdin.end();
    assert.deepEqual(await exit, [0, null]);
  }
});

test('a blocked cell ends the session', async () => {
  const session = await createSession({ timeoutMs: 300 });
  try {
    assert.match((await session.run('while (true) {}')).error, /timed out/);
    assert.match((await session.run('1')).error, /session ended/i);
  } finally {
    await session.close();
  }
});

test('a popup receives a tab ID without replacing the active tab', async () => {
  const session = await createSession();
  try {
    const result = await session.run(`
      await openTab(${JSON.stringify(url('<a href="about:blank" target="_blank">Open</a>'))});
      const original = page;
      const popup = page.waitForEvent('popup');
      await page.getByRole('link').click();
      await popup;
      console.log(tabs.length, page === original, tabs.filter(tab => tab.active).length);
    `);
    assert.equal(result.ok, true, result.error);
    assert.equal(result.output, '2 true 1');
  } finally {
    await session.close();
  }
});
