# Owner journal capacity and SQLite sidecar admission

This is measured capacity guidance, not a garbage collector or a new database.
`LocalMerchantOwnerSession.readOperations/writeOperations` reads/parses or
serializes/replaces the complete `operations.json`. Atomic rename is not a
benchmark of crash durability or directory fsync.

The A388 synthetic run uses the real session constructor and real private JSON
methods, 1,000 / 10,000 / 50,000 bound operation records, five repetitions, local
temporary files, warm filesystem cache, and no forced GC. The workload preserves
pending, reconciliation (unknown effects), and a settled idempotency tombstone
record unchanged. No business execution or provider request occurs.

| Records | Bytes | Read median / max ms | Write median / max ms | Process RSS after MiB |
|---:|---:|---:|---:|---:|
| 1,000 | 456,835 | 1.97 / 2.82 | 1.62 / 2.96 | 117.7 |
| 10,000 | 4,596,835 | 21.90 / 28.39 | 14.79 / 21.53 | 154.8 |
| 50,000 | 23,116,835 | 92.27 / 141.45 | 73.09 / 106.01 | 452.6 |

RSS/heap belong to the complete measurement process (SDK imports, input and
parsed objects, and GC timing), not a per-record allocation or production SLO.
The run samples and runtime identity are emitted through optional
`A388_EVIDENCE_DIR` by `tests/a388-owner-evaluation.test.ts`; without it the test
has no dependency on a particular temporary directory.

## Planning thresholds

Use **10,000 records or 4 MiB** as a journal capacity warning, and investigate if
a representative read/write cycle exceeds **50 ms**. At **50,000 records or
16 MiB**, or repeated cycles above **100 ms**, require a segmentation design
review before expanding workload. Process RSS above **256 MiB** during this
workload is a separate coarse memory review signal, not proof the journal alone
uses that amount. These are initial operating/design thresholds from synthetic
measurements, not enforced runtime limits. Re-measure on the deployment host,
with its real record mix and concurrent workload. Do not reject existing owner
operations or delete records merely for crossing a threshold.

A future design should retain a compact business-key index and immutable
segments. Only verifiably final, fully accounted operations may be candidates
for moving to segments. Pending, reserved, reconciliation/unknown effects,
unsettled budget accounting, and their authoritative receipts remain available
for reconciliation. Preserve idempotency tombstones, argument/business binding,
outcome references and monotonic fencing evidence. Do not TTL-delete unknown
claims, discard tombstones, recycle fencing tokens, or infer “no effect” from age.
Archival/retention, recovery, and transactional publication of an index plus a
segment require a separate reviewed implementation; none happens in this change.

## WAL/SHM boundary

A real temporary WAL database produced main/WAL/SHM files owned by the current
UID, mode 0600, under the protected 0700 directory. Changing the test WAL to 0644
was previously admitted. That is a metadata defense gap, not a demonstration of
public data access: the 0700 parent still restricts traversal.

Admission now checks each currently existing `session.sqlite-wal` and `-shm`
with `lstat`: regular file, no symlink, same UID when available, exactly 0600.
ENOENT is a currently absent sidecar; other inspection failures fail closed.
It does not chmod, delete, repair, or open suspect sidecars, and does not retain
sidecar inodes across SQLite checkpoint/recreation. Main-database inode fencing
is unchanged. Real transactions, checkpoint, close/reopen, missing sidecars, and
normal recreation are supported. Negative fixtures replace/create sidecars only
after their synthetic SQLite connection closes; active sidecars are not removed.

This is a local admission check, not a filesystem system-wide invariant or an
elimination of same-UID malicious check/use races. Wrong-UID physical ownership
was not manufactured without permission; the inherited UID check is retained,
while actual fixtures verify current-UID metadata. No production DB was opened.
