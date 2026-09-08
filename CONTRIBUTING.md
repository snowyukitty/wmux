# Contributing to wmux

Thanks for your interest in contributing to wmux! Here's how to get started.

## Getting Started

```bash
git clone https://github.com/openwong2kim/wmux.git
cd wmux
npm ci
npm run start   # dev mode
npm test        # run tests
```

Requires Node.js 22+ with **npm 11** (`npm install -g npm@11` if your Node bundles npm 10 — npm 11 owns the lockfile lineage, and `npm ci` under npm 10 rejects the lock) and Windows 10/11 (ConPTY).

Keep the lockfile's dependency tree and postinstall patches intact. If tests
report missing packages or an unapplied xterm patch, repair the installation
with `npm ci` before attributing the failure to source changes. Do not regenerate
license notices from an incomplete installation.

## Pull Requests

### One PR, One Purpose

Keep PRs focused on a single concern. Don't mix unrelated changes.

- **Security fix** → security PR only
- **New feature** → feature PR only
- **Bug fix** → bug fix PR only

If your work touches multiple areas, split it into separate PRs.

### PR Checklist

- [ ] `npx tsc --noEmit` passes
- [ ] `npm test` passes
- [ ] New code has tests
- [ ] Commit messages are clear and descriptive

### Review the failure boundaries

Choose the rows relevant to the change and record the evidence in the PR's test
plan. These checks supplement the existing suite; a green suite alone does not
establish that a new lifecycle or compatibility path is covered.

| Change | Evidence to include |
| --- | --- |
| Delayed work or persisted session references | Reuse the short id with a different incarnation; check restart, pause/resume, and identity again after an asynchronous boundary. |
| Availability or identity validation | Distinguish a verified mismatch from a timeout or missing response. Refuse unsafe work in both cases, but prove that a temporary outage can recover without destroying a valid binding. |
| Persisted data or validation policy | Load a fixture from the previous schema, perform the operation, and inspect the raw saved file. Test read-time compatibility separately from restrictions on new writes. |
| Workspace scoping | Apply scope to the evidence used for waiting, selection, retries, and fallback, as well as to the returned data. Test a foreign workspace becoming ready first. |
| Performance gates or confirmation | Preserve the first result, name the runner relationship accurately, and replay a changed threshold against observed boundary samples. A same-runner retry is not an independent measurement. |

For a bug fix, run the regression against the unchanged implementation first and
record its failure, then run it against the fix. Prefer behavioral evidence at
the handler, persistence, or transport boundary over source-text assertions.
For user-visible changes, record a relevant UI smoke test or explicitly state
that it was not run and which interaction remains unverified.

When a check fails, report the command, revision, failing cases, and observed
output. Call a failure pre-existing only with evidence from the base revision
or a linked baseline run; otherwise classify it as untriaged. Passing in
isolation does not erase a failure under the suite's normal concurrency.

Treat automated review findings as hypotheses: confirm the current call path
before changing behavior. A false positive should receive a concrete explanation
and, when useful, a regression that protects the existing contract. For every
valid finding, distinguish fixed, deliberately deferred, and still unresolved;
link follow-up work rather than treating merge status as proof of resolution.

### Test layout

Use `*.runtime.test.ts`, `*.runtime.test.tsx`, or `*.runtime.test.mjs` for
tests that spawn real OS resources, such as ConPTY shells or Windows process
probes. `npm test` runs these runtime tests serially after the regular parallel
suite to avoid cross-test contention.

Run timing-sensitive or native runtime checks without a competing build or full
test run on the same host. Record any competing workload when interpreting a
timeout; do not change a timing threshold merely to make a loaded run pass.

Keep local investigation scripts outside the test discovery paths, for example
in `.local-scratch/`. Git-ignored files under `src/**/__tests__/` still run under
Vitest: an old vulnerability demonstration asserting that an exploit succeeds
can keep failing after the production fix. Preserve that evidence separately
and put the intended safe behavior in a tracked regression test.

### Commit Style

```
<type>: <short description>

fix: resolve zombie pipe cleanup on daemon restart
feat: add split pane keyboard shortcuts
security: harden filesystem bridge path resolution
refactor: extract token writer to shared module
test: add SSRF validation coverage for IPv6-mapped IPv4
docs: update CLI reference for org commands
```

## Reporting Security Issues

If you find a security vulnerability, please **do not open a public issue**. Instead, email [open.wong2kim@gmail.com] or open a draft security advisory on GitHub. We'll respond within 48 hours.

## Code Style

- TypeScript strict mode
- Vitest for testing
- No `any` unless absolutely necessary — explain why in a comment

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
