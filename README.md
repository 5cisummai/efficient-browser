# efficient-browser

A persistent JavaScript REPL for Chromium. Requires Node 24 or newer.

```sh
npm ci
npx playwright-core install chromium --only-shell
npm run build
npm link
ebrowser repl
```

On Linux, add `--with-deps` to install system dependencies. Use `--cdp <endpoint>` to attach to an existing Chromium instance. Attached tabs are listed in `tabs`; select one with `useTab(id)`. Exiting detaches from an externally owned browser.

In the terminal, or over `repl --jsonl`, send one cell at a time:

```js
await openTab("https://example.com"); console.log((await snapshot(page)).tree);
```

Use a ref from that observation with `page.getByRef(ref)`. After acting, print `diff ?? tree` from the next snapshot. Use `{ mode: "full" }` for reading content or `{ scope: page.getByRole("main") }` to inspect a region. Compact snapshots focus on a visible dialog, menu, or listbox when it contains text or controls. Use full mode to see the background or scope a snapshot to another region. Keep the same locator object across calls to diff a scoped view. Distant changes appear in separate diff hunks.

To act and verify in the same REPL cell, use `observeAfter`. Take an initial snapshot first if you want a diff.

```js
await observeAfter(() => page.getByRef(ref).click(), {
  waitFor: page.getByRole("heading", { name: "Results" }),
});
```

It runs the action once, waits up to 2.5 seconds by default, and returns `{ reached, observation }`. If the condition times out, `reached` is false and the observation is a fresh tree. Use `state: "hidden"` to wait for something to disappear. An empty dialog leaves the main page in view.

JSONL accepts `{ "id": 1, "code": "..." }` and returns `{ id, ok, output, error? }`. Keep stdin open to retain tabs and JS bindings. Embedders can use `createSession()`, `session.run(code)`, and `session.close()`. A 30-second cell deadline ends the session. If a timed-out cell dispatched an action, inspect the browser before retrying.

Run model-generated JavaScript inside a dedicated sandbox. The evaluator can execute Node code and inherits the worker's environment.

Run `npm test` for browser integration checks and `node scripts/benchmark.mjs` for the synthetic multi-tab benchmark after building.

The initial Vercel benchmark opened four synthetic table tabs. The 2 GB and 4 GB configurations both completed it, with median warm snapshot calls of 42 ms and 26 ms respectively. The reported cgroup high-water marks were 1,221 MiB and 1,223 MiB and include setup activity. Compact output was 12,051 bytes versus 15,406 bytes for raw Playwright output, with the compact output hitting its size cap. Use 4 GB for initial deployment until representative pages have been measured.

Run `ebrowser` or `ebrowser --help` to see the commands. Separate shell calls can share the same browser and JavaScript state.

```sh
ebrowser js 'const tab = await openTab("https://example.com")'
ebrowser js 'console.log(await tab.title())'
ebrowser close
```

Sessions are scoped to the current directory. Use `--session <name>` on each call to keep runs separate, and `--cdp <endpoint>` on the first call to attach to an existing browser. Sessions close after 15 minutes without a command. Failed cells exit with status 1.
