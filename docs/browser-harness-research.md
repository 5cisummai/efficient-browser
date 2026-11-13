# Browser harness research

For `efficient-browser`, use a persistent host-side JavaScript evaluator with a Playwright-shaped API. Keep Chromium and its DevTools connection behind that API. The agent gets one tool, `js({ code })`, and can compose actions, retain bindings, and return a small observation in one call. The CLI and the agent should use the same session implementation.

## What existing tools do

| Project | Execution and browser connection | Pattern to borrow |
| --- | --- | --- |
| Aside | A persistent JavaScript REPL exposes `page`, tab helpers and `snapshot()`. Asidewright wraps CDP methods behind Playwright-style calls and uses a custom accessibility tree. The installed CLI exposes interactive, one-shot, file and JSON modes. | Give the agent one composable language interface. Return the full tree on initial inspection and a diff after actions. Use screenshots when the structured view is insufficient. [Aside engineering write-up](https://aside.com/blog/how-we-built-the-sota-browser-agent-that-outperforms-fable) |
| Browser Use | Its Python worker executes cells in a retained namespace. A parent can kill and restart the worker on timeout while the browser survives. The separate Browser Harness daemon holds the CDP WebSocket and relays messages over local IPC. | Keep the browser lifecycle independent of the evaluator if you want to recover from a wedged cell without losing tabs. Distinguish a host REPL cell from JavaScript evaluated inside the page. [REPL worker](https://github.com/browser-use/browser-use/blob/main/browser_use/repl/worker.py) · [Worker supervisor](https://github.com/browser-use/browser-use/blob/main/browser_use/repl/session.py) · [CDP daemon](https://github.com/browser-use/browser-harness/blob/main/src/browser_harness/daemon.py) |
| Playwright CLI | Named sessions persist browser state across CLI commands. The CLI offers snapshots and individual actions as well as `run-code` for Playwright snippets. Its headless sessions support idle shutdown. | Separate the command transport from browser state. The existence of `run-code` alone does not establish persistent lexical bindings across calls. [Commands](https://github.com/microsoft/playwright-cli#commands) · [Session management](https://github.com/microsoft/playwright-cli/blob/main/skills/playwright-cli/references/session-management.md) |
| Vercel agent-browser | A native Rust CLI sends commands to a background daemon that controls Chromium through CDP. Its snapshot implementation calls `Accessibility.getFullAXTree` and associates durable refs with browser session, frame and backend DOM node, tracking document changes. | Bind refs to real element identity and invalidate them when the document changes. Reserve direct CDP for places where a higher-level API cannot provide the needed data. [Project README](https://github.com/vercel-labs/agent-browser) · [Snapshot implementation](https://github.com/vercel-labs/agent-browser/blob/main/cli/src/native/snapshot.rs) |

## Proposed architecture

```text
Terminal REPL / script / JSON Lines / agent js tool
                        │
             Persistent JavaScript session
                        │
      Browser facade + snapshot/ref implementation
                        │
                   playwright-core
                        │
          Owned Chromium or explicit CDP attach
```

- **Launch and attach.** Launch one headless Chromium instance in an isolated context for the default path. Keep an explicit CDP attach option for an existing instance. Playwright calls CDP attachment lower fidelity than its native connection, so validate attach separately. Track ownership and disconnect from an attached browser without shutting it down or closing pre-existing tabs. [Playwright BrowserType](https://playwright.dev/docs/api/class-browsertype#browser-type-connect-over-cdp)
- **Execution.** Start with one long-running process per browser session and serialize cells. A JSON Lines mode can serve an agent that keeps stdin and stdout open. A shell command that exits after each invocation cannot preserve lexical bindings unless it sends work to an existing process. Make timeout behavior explicit. An async deadline by itself does not stop an infinite JavaScript loop or cancel a browser action already dispatched. For the first sandboxed prototype, terminating a wedged session is an acceptable recovery path. If preserving tabs through timeouts matters, separate the evaluator from browser ownership and terminate the evaluator on timeout.
- **Browser calls.** Put Playwright in charge of navigation, locator matching, actionability, frame handling and input. Start with `openTab(url)`, `page`, `tabs`, `closeTab()`, and `snapshot()`, plus ordinary locator calls and screenshots. Add CDP behind the facade only if an implementation need warrants it. Playwright supports sending CDP commands via a Chromium `CDPSession`. [Playwright CDPSession](https://playwright.dev/docs/api/class-cdpsession) · [Locator actions](https://playwright.dev/docs/actionability)
- **Snapshots and refs.** Verify the installed Playwright release's snapshot and ref APIs before building a separate AX engine. Keep an actionable view and a fuller view, bound output on node boundaries, and use the same scope and options on both sides of a diff. Keep refs unique within a session and tied to their page, frame and document. Resolve them against element identity or reject them as stale. A reused label or ordinal can point at the wrong control after a reorder. Retain IDs for unchanged nodes where the underlying API supports identity so small UI updates produce small diffs.
- **Isolation.** Run model-supplied cells inside the Vercel microVM, with a dedicated browser profile and only the capabilities the session needs. A curated global namespace is an interface boundary. Node explicitly says its `vm` module is not a security mechanism. [Node vm documentation](https://nodejs.org/api/vm.html) · [Vercel Sandbox](https://vercel.com/docs/sandbox)

## Local checks

- With Node 24 and published `playwright-core@1.65.0` on macOS, Playwright’s matching headless shell returned both a top-level ref and a nested iframe ref from `page.ariaSnapshot({ mode: 'ai' })`. `page.getByRef()` read the iframe element and clicked a button. The next snapshot reflected the changed button and its focus state and retained the iframe ref. Start with these APIs for the first implementation. Test ref behavior across reloads and reordering before committing to stability guarantees. [Playwright Page API](https://playwright.dev/docs/api/class-page)
- With a separately launched headless shell, `chromium.connectOverCDP()` produced an AI snapshot. Closing the Playwright connection left the shell and its default-context tab available to a second attachment. [Playwright CDP attachment](https://playwright.dev/docs/api/class-browsertype#browser-type-connect-over-cdp)
- Node 24.15’s programmatic `node:repl` evaluator retained a top-level `const` declared with `await` across two separate evaluations using in-memory streams. This is a candidate for shared CLI and agent evaluation. Output capture, asynchronous errors and timeout handling still need validation. [Node REPL API](https://nodejs.org/api/repl.html)

## Prototype and measurements

1. Start Chromium headless shell with one persistent session. Drive a local fixture across two calls. The first creates a binding and snapshots a tab. The second uses the saved binding and a ref to act, then returns the diff. [Playwright Chromium headless shell](https://playwright.dev/docs/browsers#chromium-headless-shell)
2. Exercise a reordering list, duplicate names, an iframe, a popup and a navigation. Check that ambiguous or stale refs fail rather than clicking a different element. Check that the CLI shuts down owned Chromium and leaves an attached instance running.
3. Run the same workload in 4 GB and 2 GB Vercel Sandboxes. Record whole-VM peak memory, cold start, warm cell latency and snapshot bytes or tokens. Include multi-tab pages and screenshot capture. Vercel allocates 2 GB per vCPU. [Vercel Sandbox resources](https://vercel.com/sandbox)

Start with Playwright snapshots and refs. Prototype a CDP-based observer only if the fixture or workload shows that Playwright cannot expose the needed identity or state. Peak memory and latency on Vercel Sandbox have yet to be measured.
