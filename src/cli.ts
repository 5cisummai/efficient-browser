#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { sendCell } from './daemon.js';
import { parseArgs } from 'node:util';
import { createSession } from './session.js';

const help = `Usage: ebrowser <command> [options]

Commands:
  js <code>   Run JavaScript in a persistent browser session
  close       Close a persistent browser session
  repl        Start an interactive or JSON Lines REPL
  help        Show this help

Options:
  --session <name>    Select a js or close session (default: default)
  --cdp <endpoint>    Attach js or repl to a running Chromium instance
  --jsonl             Read and write JSON Lines in repl
  -h, --help          Show this help

Examples:
  ebrowser js 'await openTab("https://example.com")'
  ebrowser js 'console.log(await page.title())'
  ebrowser close
`;

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      jsonl: { type: 'boolean' },
      cdp: { type: 'string' },
      session: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [command, ...args] = positionals;
  if (values.help || !command || command === 'help') {
    console.log(help.trimEnd());
    return;
  }
  if (command === 'js' || command === 'close') {
    if (values.jsonl || (command === 'js' ? args.length !== 1 || !args[0].trim() : args.length || values.cdp))
      throw new Error(command === 'js' ? 'Usage: ebrowser js <code> [--session <name>] [--cdp <endpoint>]' : 'Usage: ebrowser close [--session <name>]');
    const result = await sendCell(values.session ?? 'default', command === 'js'
      ? { code: args[0], cdp: values.cdp }
      : { close: true });
    if (result.output) console.log(result.output);
    if (!result.ok) throw new Error(result.error ?? 'JavaScript cell failed.');
    return;
  }
  if (command !== 'repl' || args.length || values.session !== undefined)
    throw new Error('Invalid command or options. Run ebrowser --help.');
  const session = await createSession({ cdp: values.cdp });
  const interactive = !values.jsonl && Boolean(process.stdin.isTTY);
  const lines = createInterface({
    input: process.stdin,
    output: values.jsonl ? undefined : process.stdout,
    terminal: interactive,
    prompt: 'browser> ',
  });
  let inputClosed = false;
  lines.once('close', () => { inputClosed = true; });
  try {
    if (interactive && !inputClosed) lines.prompt();
    for await (const line of lines) {
      if (!line.trim()) {
        if (interactive && !inputClosed) lines.prompt();
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
        if (interactive && !inputClosed) lines.prompt();
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
