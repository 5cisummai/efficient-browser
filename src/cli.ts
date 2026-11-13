#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { createSession } from './session.js';

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { jsonl: { type: 'boolean' }, cdp: { type: 'string' }, help: { type: 'boolean' } },
  });
  if (values.help || positionals.length !== 1 || positionals[0] !== 'repl') {
    console.log('Usage: efficient-browser repl [--jsonl] [--cdp <endpoint>]');
    process.exitCode = values.help ? 0 : 1;
    return;
  }
  const session = await createSession({ cdp: values.cdp });
  const lines = createInterface({
    input: process.stdin,
    output: values.jsonl ? undefined : process.stdout,
    terminal: !values.jsonl && Boolean(process.stdin.isTTY),
    prompt: 'browser> ',
  });
  try {
    if (!values.jsonl) lines.prompt();
    for await (const line of lines) {
      if (!line.trim()) {
        if (!values.jsonl) lines.prompt();
        continue;
      }
      if (values.jsonl) {
        let request;
        try { request = JSON.parse(line); } catch { /* reported below */ }
        const id = request?.id ?? null;
        const result = typeof request?.code === 'string' && (typeof id === 'string' || typeof id === 'number')
          ? await session.run(request.code)
          : { ok: false, output: '', error: 'Expected an object with id and code.' };
        console.log(JSON.stringify({ id, ...result }));
      } else {
        if (line === '.exit') break;
        const result = await session.run(line);
        if (result.output) console.log(result.output);
        if (result.error) console.error(result.error);
        lines.prompt();
      }
    }
  } finally {
    lines.close();
    await session.close();
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
