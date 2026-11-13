import { createPatch } from 'diff';
import type { Locator, Page } from 'playwright-core';

type Node = string | {
  role: string;
  name?: string;
  ref?: string;
  children?: Node[];
  [key: string]: unknown;
};

const actions = new Set('button link textbox searchbox combobox checkbox radio switch slider spinbutton tab option menuitem menuitemcheckbox menuitemradio treeitem'.split(' '));
const overlays = new Set(['dialog', 'alertdialog', 'listbox', 'menu']);
const context = new Set('paragraph legend group listbox menu heading alert status dialog alertdialog region navigation main form row cell rowheader columnheader iframe'.split(' '));

function hasContent(nodes: Node[]): boolean {
  return nodes.some(node => typeof node === 'string'
    ? Boolean(node.trim())
    : Boolean(node.name?.trim() || (typeof node.text === 'string' && node.text.trim()) ||
        (node.ref && actions.has(node.role)) || hasContent(node.children ?? [])));
}

function foreground(nodes: Node[]): Exclude<Node, string> | undefined {
  let active: Exclude<Node, string> | undefined;
  function visit(list: Node[]) {
    for (const node of list) {
      if (typeof node === 'string') continue;
      if (overlays.has(node.role) && hasContent(node.children ?? []) && (node.ref || !active)) active = node;
      visit(node.children ?? []);
    }
  }
  visit(nodes);
  return active;
}

export function observations() {
  const states = new WeakMap<Page, {
    epoch: number;
    previous?: { mode: string; scope?: Locator; foreground?: string; tree: string; omitted: boolean };
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
    const overlay = mode === 'compact' && !scope ? foreground(nodes) : undefined;
    const lines = [`${JSON.stringify(title.slice(0, 300))} · ${page.url().slice(0, 500)}`];
    let size = lines[0].length;
    let omitted = false;
    let previousText: string | undefined;
    function render(list: Node[], depth: number, parentName?: string) {
      for (const node of list) {
        if (omitted) return;
        const indent = '  '.repeat(depth);
        if (typeof node === 'string') {
          const value = node.replace(/\s+/g, ' ').trim();
          if (value && value !== parentName && value !== previousText &&
              (mode === 'full' || overlay || scope)) {
            append(indent + JSON.stringify(value.slice(0, 400)));
            previousText = value;
          }
          continue;
        }
        const keep = mode === 'full' || actions.has(node.role) || (context.has(node.role) && (node.name || !['group', 'paragraph'].includes(node.role) || overlay || scope)) ||
          (node.active && node.role !== 'generic') || node.cursor === 'pointer';
        if (keep) {
          const content = typeof node.text === 'string' && (mode === 'full' || overlay || scope || node.role === 'heading')
            ? node.text : undefined;
          const label = node.name || content;
          const name = label ? ' ' + JSON.stringify(label.slice(0, 400)) : '';
          const ref = node.ref && (mode === 'full' || actions.has(node.role) || node.cursor === 'pointer' || overlays.has(node.role) || ['main', 'region', 'navigation', 'form', 'iframe'].includes(node.role)) ? ` [ref=r${generation}:${node.ref}]` : '';
          const flags = ['value', 'placeholder', 'active', 'disabled', 'checked', 'expanded', 'selected', 'pressed', 'required']
            .filter(key => node[key] !== undefined)
            .map(key => ` [${key}=${JSON.stringify(typeof node[key] === 'string' ? node[key].slice(0, 200) : node[key])}]`).join('');
          append(indent + (mode === 'full' ? '- ' : '') + node.role + name + ref + flags);
          previousText = undefined;
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
    render(overlay ? [overlay] : nodes, 0);
    if (overlay) append('[Background omitted. Use a full or scoped snapshot to inspect it.]');
    const tree = lines.join('\n');
    const previous = entry.previous;
    entry.previous = { mode, scope, foreground: overlay?.ref, tree, omitted };
    if (!previous || previous.mode !== mode || previous.scope !== scope ||
        previous.foreground !== overlay?.ref || previous.omitted || omitted)
      return { tree, diff: null };
    if (previous.tree === tree) return { tree, diff: '' };
    const diff = createPatch('snapshot', previous.tree + '\n', tree + '\n', undefined, undefined, { context: 1 })
      .split('\n').slice(4).join('\n').trimEnd();
    return { tree, diff: diff.length < tree.length ? diff : null };
  }

  return { snapshot, getByRef };
}
