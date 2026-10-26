# Filesystem regression coverage

All fixtures must be temporary dummy files. Do not use real outside-root
data or live mounts to exercise containment or resource limits.

## Copy traversal budget lesson (#43)

The first containment regression suite checked escape/deny refusals,
legitimate aliases, cycles, byte counts, and limits during `fs.cp`. It did
not check the preflight frontier. Eventual rejection is insufficient: a
walker can enqueue far more paths than its entry cap before it consumes
enough entries to reject. The independent review missed the same distinction.
Copilot reported it after merge/deployment; that timing does not remove the
gap in the original tests and review.

For dereferenced preflight, reserve each child before constructing/enqueueing
its path: processed entries + pending paths + the next child must not exceed
`maxCopyEntries`. Repeated safe aliases consume separate reservations because
they produce separate copies. Stream directory names rather than allocating
the full listing first, and close the iterator on refusal.

`copy-budget.test.ts` uses small wide trees and repeated aliases to observe
how much discovery occurs before refusal, checks that no copy starts, and
tests exact-limit success. Keep these assertions if traversal changes; an
error-only assertion would miss the original defect. One additional child
name is observed to prove overflow, but it is never enqueued. The cap bounds
processed plus queued paths, not total bytes of process memory: directory
buffering, path lengths and the guard's ancestry sets also consume space.
Count an eager `readdir` result's entire length when it resolves, not only
names subsequently consumed. Otherwise bounded enqueueing could hide an
unbounded listing allocation. A premerge automated review exposed this second
observer gap; validate it with eager enumeration while retaining reservations.
Queue shifting and copied ancestry sets have costs tied to entry count and
depth. These small fixtures do not establish process RSS or latency limits.
Path checks still cannot eliminate concurrent validation-to-I/O races.
