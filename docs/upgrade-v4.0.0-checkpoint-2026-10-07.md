# wmux 4.0.0 synchronization checkpoint

Checkpoint date: 2026-10-07 (JST). The fork branch
[`sync/upstream-4.0-20261007`](https://github.com/snowyukitty/wmux/tree/sync/upstream-4.0-20261007)
contains upstream 4.0.0 plus the retained fork changes. The verified code revision
is `6528dddae076e0177e38eee6b150f7b72feeabe5`; the upstream baseline is
`13251157bf6c6fe4a0885b6906a698ff0d0c17cd`.

The Windows development package builds successfully. Installation, a signed
release, and interactive UI verification are outside this checkpoint.

## Changes retained and added

- Merge upstream 4.0.0 while retaining contributor verification guidance and
  local persistence and runtime regressions.
- Include the pending usage preference serialization test from PR #1819.
- Apply compatible dependency updates and declare the ESLint 8 types directly.
- Upgrade MCP SDK to 1.32.1 for
  [GHSA-6qxp-vccf-f47h](https://github.com/advisories/GHSA-6qxp-vccf-f47h)
  and regenerate `THIRD_PARTY_NOTICES`.
- Isolate skill metadata fixtures from real account home directories and use
  directory junctions for the relevant Windows fixtures.
- Keep the retired Unix socket inode allocated in the relay restart test so
  rapid rebinding cannot reuse its identity. Assertions remain intact.

## Verification

Linux verification used Node 22.23.3, npm 11.2.0, Git 2.43, and Playwright 1.58.2
with its matching Chromium. Tests ran as an unprivileged user in a container
with an init process, four CPUs, and 8 GiB of memory. The final run used a fresh
`npm ci` on the final lockfile and a freshly built daemon.

| Check | Result |
| --- | --- |
| Linux general suite | 1,670 files passed, 4 skipped; 25,136 tests passed, 79 skipped |
| Linux runtime suite | 25 files passed, 9 skipped; 311 tests passed, 97 skipped |
| Windows runtime suite | 32 files passed, 2 skipped; 369 tests passed, 54 skipped, before the final MCP SDK update |
| Windows native helper | 43 C# tests passed; NativeAOT build passed |
| Type checking | All eight slices passed before the final MCP SDK update; daemon tests and MCP build program passed after their final changes |
| Build and protocol checks | Daemon, web CSP gate, MCP, CLI, Windows package, and final MCP protocol probe passed |
| Package integrity | Three external bundles present; native helper hash matches its pin; generated MCP cache excluded |
| License notices | 237 production packages accepted by the existing policy; generated notices check passed |
| Dependency audit | Production: 0 advisories. Full lockfile: 44 development advisories, 38 high and 6 moderate |

The Windows runtime result does not validate the final MCP SDK update. That
update was separately checked through MCP type checking, the protocol probe,
the rebuilt Windows package, and both final Linux suites. Daemon and main source
do not import the MCP SDK.

The initial Windows general suite had 13 failing files and 30 failing tests,
with 1,652 files and 25,017 tests passing. Failures included file symlink
`EPERM`, unavailable `mkfifo`, fixture isolation, and timeouts. Subsequent focused
runs passed the corrected skill fixture and selected HTTP cases. The full
Windows general suite was not rerun and is **not** recorded as passing; the
remaining failures have not been established as inherited from the baseline.

## Upstream contribution status

As checked at this checkpoint, PRs
[#1718](https://github.com/openwong2kim/wmux/pull/1718),
[#1719](https://github.com/openwong2kim/wmux/pull/1719),
[#1720](https://github.com/openwong2kim/wmux/pull/1720),
[#1723](https://github.com/openwong2kim/wmux/pull/1723),
[#1774](https://github.com/openwong2kim/wmux/pull/1774), and
[#1784](https://github.com/openwong2kim/wmux/pull/1784) are merged.

[#1819](https://github.com/openwong2kim/wmux/pull/1819) remains open, mergeable,
and clean. All executed checks succeeded; `bench-confirm` was skipped. There
are no actionable review comments. The review bot has a generic docstring
coverage warning. The fork includes the change through commit `acb6a4d6`.
These statuses are a dated snapshot and should be refreshed before further work.

## Follow-up

1. Recheck #1819 for maintainer feedback or merge status. Keep its contribution
   branch separate from the full synchronization branch.
2. Verify the packaged Windows UI before installation or release. Reproduce
   remaining Windows suite failures with suitable platform fixtures and record
   baseline evidence before classifying them as inherited.
3. Review remaining development dependency advisories without an unreviewed
   breaking upgrade. Audit counts are a snapshot, not a permanent guarantee.
4. Investigate the relay identity heuristic separately: a filesystem can reuse
   both the socket inode and creation timestamp. The deterministic restart
   fixture does not fix that production identity collision.

The synchronization branch is a source checkpoint. No release tag, installer
publication, or upstream merge was performed.
