# efficient-browser

A persistent JavaScript REPL for Chromium. Requires Node 24 or newer.

```sh
npm ci
npx playwright-core install chromium --only-shell
npm run build
node dist/cli.js repl
```

On Linux, add `--with-deps` to install system dependencies. Use `--cdp <endpoint>` to attach to an existing Chromium instance. Attached tabs are listed in `tabs`; select one with `useTab(id)`. Exiting detaches from an externally owned browser.

In the terminal, or over `repl --jsonl`, send one cell at a time:

```js
await openTab("https://example.com"); console.log((await snapshot(page)).tree);
```

Use a ref from that observation with `page.getByRef(ref)`. After acting, print `diff ?? tree` from the next snapshot. Use `{ mode: "full" }` for reading content or `{ scope: page.getByRole("main") }` to inspect a region. Keep the same locator object across calls to diff a scoped view.

JSONL accepts `{ "id": 1, "code": "..." }` and returns `{ id, ok, output, error? }`. Keep stdin open to retain tabs and JS bindings. Embedders can use `createSession()`, `session.run(code)`, and `session.close()`. A 30-second cell deadline ends the session. If a timed-out cell dispatched an action, inspect the browser before retrying.

Run model-generated JavaScript inside a dedicated sandbox. The evaluator can execute Node code and inherits the worker's environment.

Run `npm test` for browser integration checks and `node scripts/benchmark.mjs` for the synthetic multi-tab benchmark after building.

The initial Vercel benchmark opened four synthetic table tabs. The 2 GB and 4 GB configurations both completed it, with median warm snapshot calls of 42 ms and 26 ms respectively. The reported cgroup high-water marks were 1,221 MiB and 1,223 MiB and include setup activity. Compact output was 12,051 bytes versus 15,406 bytes for raw Playwright output, with the compact output hitting its size cap. Use 4 GB for initial deployment until representative pages have been measured.
