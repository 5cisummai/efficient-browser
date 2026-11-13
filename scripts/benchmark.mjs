import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { createSession } from '../dist/session.js';

const session = await createSession();
try {
  const setup = await session.run(`
    const rows = Array.from({length: 120}, (_, i) =>
      '<tr><td>Customer ' + i + '</td><td><div><button>Edit</button></div></td></tr>').join('');
    const url = 'data:text/html,' + encodeURIComponent('<h1>Customers</h1><table>' + rows + '</table>');
    for (let i = 0; i < 4; i++) await openTab(url);
    const raw = await page.ariaSnapshot({mode: 'ai'});
    const compact = (await snapshot(page)).tree;
    console.log(JSON.stringify({rawBytes: Buffer.byteLength(raw), compactBytes: Buffer.byteLength(compact)}));
  `);
  if (!setup.ok) throw new Error(setup.error);
  const elapsed = [];
  for (let i = 0; i < 20; i++) {
    const start = performance.now();
    const result = await session.run('console.log((await snapshot(page)).diff);');
    if (!result.ok) throw new Error(result.error);
    elapsed.push(performance.now() - start);
  }
  const peak = await readFile('/sys/fs/cgroup/memory.peak', 'utf8').catch(() => '');
  const memory = await readFile('/proc/meminfo', 'utf8').catch(() => '');
  console.log(JSON.stringify({
    ...JSON.parse(setup.output),
    medianCellMs: Math.round(elapsed.sort((a, b) => a - b)[10]),
    cgroupPeakMiB: peak ? Math.round(Number(peak) / 2 ** 20) : null,
    vmMemory: memory.split('\n')[0] || null,
  }));
} finally {
  await session.close();
}
