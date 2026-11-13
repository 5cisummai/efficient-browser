---
name: ebrowser
description: Browse and interact with websites through the ebrowser CLI and its persistent JavaScript REPL. Use when the user requests ebrowser or a shell-based Chromium session for browser tasks and UI testing.
---

# ebrowser

Use `ebrowser` for browser work assigned to this skill. Honor an explicit request for a different browser tool. Run `ebrowser --help` to check the installed commands. If the CLI or browser is unavailable, report the failure and use a suitable fallback when the task allows it.

Use `ebrowser js` from the same working directory with the same `--session` name for every call in a task. The background session preserves JavaScript bindings, tabs, and snapshot history across shell invocations. Pick a distinct session name for each independent run.

```bash
ebrowser js --session lookup 'const tab = await openTab("https://example.com"); console.log((await snapshot(tab)).tree)'
ebrowser js --session lookup 'console.log(await tab.title())'
ebrowser close --session lookup
```

The default browser is headless Chromium. To use an existing Chromium instance, supply its explicit `--cdp <endpoint>` on the first call. Inspect `tabs` and select the intended tab with `useTab(id)`, or open a separate tab for the task. Close sessions you started once the task is done, unless the user wants them kept open.

- Read `snapshot(page).tree` first. Prefer a scoped snapshot such as `snapshot(page, { scope: page.getByRole("main") })` when the page is long. Use `mode: "full"` or a screenshot when compact output omits needed context.
- Act on a fresh snapshot ref with `page.getByRef(ref)` or use a Playwright semantic locator. After a stale ref or a timeout, inspect the current state before retrying. A failed wait can occur after the action already happened.
- Use `observeAfter(() => locator.click(), { waitFor: expectedLocator })` when you know what should appear. Inspect `reached` and the returned `observation`. For ordinary snapshots, print `diff ?? tree` after an action when the earlier tree is still in context.
- Print only the result needed for the next decision. Use `console.log` for selected values. A failed `js` cell exits nonzero. Use `ebrowser repl --jsonl` when a host already maintains a persistent stdin/stdout connection.
