import type { Locator, Page } from 'playwright-core';

type Node = string | {
  role: string;
  name?: string;
  ref?: string;
  children?: Node[];
  [key: string]: unknown;
};

const actions = new Set('button link textbox searchbox combobox checkbox radio switch slider spinbutton tab option menuitem menuitemcheckbox menuitemradio treeitem'.split(' '));
const context = new Set('heading alert status dialog alertdialog region navigation main form row cell rowheader columnheader iframe'.split(' '));

export function observations() {
  const states = new WeakMap<Page, {
    epoch: number;
    previous?: { mode: string; scope?: Locator; tree: string };
  }>();
  let epoch = 0;

  function state(page: Page) {
    let entry = states.get(page);
    if (!entry) {
      const initial = { epoch: ++epoch, previous: undefined };
      entry = initial;
      states.set(page, entry);
      page.on('framenavigated', () => {
        const current = states.get(page)!;
        current.epoch = ++epoch;
        current.previous = undefined;
      });
      page.on('framedetached', () => {
        const current = states.get(page)!;
        current.epoch = ++epoch;
        current.previous = undefined;
      });
    }
    return entry;
  }

  function getByRef(page: Page, ref: string) {
    const match = /^r(\d+):(\w+)$/.exec(ref);
    if (!match || Number(match[1]) !== state(page).epoch || page.isClosed())
      throw new Error('Stale snapshot ref. Take a fresh snapshot.');
    return page.getByRef(match[2]);
  }

  async function snapshot(page: Page, { mode = 'compact', scope }: {
    mode?: 'compact' | 'full'; scope?: Locator;
  } = {}) {
    const entry = state(page);
    const generation = entry.epoch;
    const title = await page.title();
    const nodes = await (scope ?? page).ariaSnapshotJSON({ mode: 'ai' }) as Node[];
    if (entry.epoch !== generation) throw new Error('Page changed during snapshot. Try again.');
    const lines = [`${JSON.stringify(title.slice(0, 300))} · ${page.url().slice(0, 500)}`];
    let size = lines[0].length;
    let omitted = false;
    function render(list: Node[], depth: number, parentName?: string) {
      for (const node of list) {
        if (omitted) return;
        const indent = '  '.repeat(depth);
        if (typeof node === 'string') {
          if (mode === 'full' && node !== parentName) append(indent + JSON.stringify(node.slice(0, 400)));
          continue;
        }
        const keep = mode === 'full' || actions.has(node.role) || context.has(node.role) ||
          (node.active && node.role !== 'generic') || node.cursor === 'pointer';
        if (keep) {
          const name = node.name ? ' ' + JSON.stringify(node.name.slice(0, 400)) : '';
          const ref = node.ref ? ` [ref=r${generation}:${node.ref}]` : '';
          const flags = ['active', 'disabled', 'checked', 'expanded', 'selected', 'pressed', 'required']
            .filter(key => node[key] !== undefined)
            .map(key => ` [${key}=${String(node[key])}]`).join('');
          append(indent + '- ' + node.role + name + ref + flags);
        }
        render(node.children ?? [], keep ? depth + 1 : depth, node.name);
      }
    }
    function append(line: string) {
      if (size + line.length + 1 > 12_000) {
        omitted = true;
        lines.push('[Remaining content omitted. Scope the next snapshot to a region.]');
      } else {
        lines.push(line);
        size += line.length + 1;
      }
    }
    render(nodes, 0);
    const tree = lines.join('\n');
    const previous = entry.previous;
    entry.previous = { mode, scope, tree };
    if (!previous || previous.mode !== mode || previous.scope !== scope || omitted)
      return { tree, diff: null };
    const before = previous.tree.split('\n');
    let start = 0;
    while (start < before.length && before[start] === lines[start]) start++;
    let end = 0;
    while (end < Math.min(before.length, lines.length) - start &&
      before.at(-end - 1) === lines.at(-end - 1)) end++;
    const removed = before.slice(start, before.length - end);
    const added = lines.slice(start, lines.length - end);
    const diff = removed.length || added.length
      ? [`@@ line ${start + 1} @@`, ...removed.map(line => '- ' + line), ...added.map(line => '+ ' + line)].join('\n')
      : '';
    return { tree, diff: diff.length < tree.length ? diff : null };
  }

  return { snapshot, getByRef };
}
