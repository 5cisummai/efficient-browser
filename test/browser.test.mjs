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

test('compact snapshots prioritize a dialog and retain text beside unnamed controls', async () => {
  const session = await createSession();
  try {
    const result = await session.run(`
      await openTab('about:blank');
      await page.setContent('<main><button>Background action</button></main><dialog><p>Which way is north?</p><div><input type="radio">Toward the pole</div><button>Close</button></dialog>');
      await page.locator('dialog').evaluate(dialog => dialog.showModal());
      const before = await snapshot(page);
      await page.locator('dialog').evaluate(dialog => dialog.close());
      const after = await snapshot(page);
      console.log(JSON.stringify({ before: before.tree, after }));
    `);
    assert.equal(result.ok, true, result.error);
    const { before, after } = JSON.parse(result.output);
    assert.match(before, /Which way is north\?/);
    assert.match(before, /radio.*\n.*Toward the pole/);
    assert.doesNotMatch(before, /Background action/);
    assert.match(after.tree, /Background action/);
    assert.equal(after.diff, null);
  } finally {
    await session.close();
  }
});

test('distant page changes produce separate diff hunks', async () => {
  const session = await createSession();
  try {
    const result = await session.run(`
      await openTab('about:blank');
      await page.setContent('<button>First</button>' + Array.from({length: 20}, (_, i) => '<button>Middle ' + i + '</button>').join('') + '<button>Last</button>');
      await snapshot(page);
      await page.getByRole('button', { name: 'First' }).evaluate(button => button.textContent = 'Started');
      await page.getByRole('button', { name: 'Last' }).evaluate(button => button.textContent = 'Finished');
      console.log((await snapshot(page)).diff);
    `);
    assert.equal(result.ok, true, result.error);
    assert.match(result.output, /Started/);
    assert.match(result.output, /Finished/);
    assert.equal(result.output.match(/^@@ /gm)?.length, 2);
    assert.doesNotMatch(result.output, /Middle 10/);
  } finally {
    await session.close();
  }
});

test('observeAfter waits for the intended state and keeps the page visible behind an empty dialog', async () => {
  const session = await createSession();
  try {
    const result = await session.run(`
      await openTab('about:blank');
      await page.setContent('<dialog open><div></div></dialog><button onclick="setTimeout(() => document.querySelector(&quot;h1&quot;).hidden = false, 50)">Show result</button><h1 hidden>Ready</h1>');
      const before = await snapshot(page);
      const after = await observeAfter(() => page.getByRole('button').click(), {
        waitFor: page.getByRole('heading', { name: 'Ready' })
      });
      let calls = 0;
      const missed = await observeAfter(() => { calls++; }, {
        waitFor: page.getByRole('heading', { name: 'Missing' }), timeout: 50
      });
      console.log(JSON.stringify({ before: before.tree, after, missed, calls }));
    `);
    assert.equal(result.ok, true, result.error);
    const { before, after, missed, calls } = JSON.parse(result.output);
    assert.match(before, /Show result/);
    assert.doesNotMatch(before, /Background omitted/);
    assert.equal(after.reached, true);
    assert.match(after.observation, /Ready/);
    assert.equal(missed.reached, false);
    assert.match(missed.observation, /Show result/);
    assert.equal(calls, 1);
  } finally {
    await session.close();
  }
});
