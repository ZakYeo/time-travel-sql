# Portable recording streams

`@time-travel-sql/exchange` now exports and imports authoritative recorded history
through public SDK contracts. A recording can be written to a file, moved to an
empty local store and reconstructed after the source store is closed. No source
connection or credentials are required.

## Semantic format, version 1

The stream uses the bounded UTF-8 JSONL framing in `docs/recording-framing.md`.
Inside its physical data frames are exactly these semantic records, in order:

1. One manifest: `{ kind: "manifest", version: 1, info,
captureConfigurationFingerprint }`.
2. Exactly `info.baselineRowCount` records shaped
   `{ kind: "baseline", row: { tableId, row } }`.
3. Exactly `info.transactionCount` records shaped
   `{ kind: "transaction", transaction }`.

`info` uses the public canonical `RecordingInfo` encoding. It contains the local
recording name/ID/creation time, source and epoch identity, versioned schema,
lifecycle, baseline position/checksum/count, head position and committed count.
The baseline must already be published. Row values and transactions use the same
canonical SDK decoders as live capture and local storage, including exact tagged
scalars, unavailable values, transaction identity/order and optional microsecond
commit timestamps. No executable DDL, source triggers, functions or SQL scripts
are included or executed.

The capture configuration fingerprint is lowercase SHA-256 of UTF-8
`JSON.stringify(info.recording)` after canonical SDK decoding. Its scope is the
recorded table/column projection, schema metadata, source and epoch identity.
It excludes credentials, driver settings, local names/lifecycle and source
resource receipts. It does not yet establish column-policy provenance; that
remaining capture/privacy requirement must not be inferred from this fingerprint.

Baseline rows are strictly ordered by UTF-8 bytes of the canonical SDK `rowKey`.
This is deliberately distinct from UTF-16 string ordering for supplementary Unicode
characters. For each canonically decoded `SnapshotRow`, compute
`rowDigest = SHA256(UTF8(JSON.stringify(snapshotRow)))`. The baseline checksum is
SHA-256 over the concatenation of `JSON.stringify([rowKey, rowDigest]) + "\n"`
for all baseline rows in that order. An empty baseline hashes the empty byte string.
These are logical data commitments, independent of SQLite tables, pages or files.

Transactions must form one exact predecessor chain from the baseline through the
declared head. Duplicates, extra or missing records, unknown references, stale
before-images, key collisions and malformed values fail. The outer framing trailer
commits the manifest and every data record, including their order. Checksums detect
corruption; they do not prove authenticity.

## Export ownership and consistency

`createLocalExporter({ path, replayLimits?, maxConcurrent? })` returns a bounded
SDK `HistoryExports` provider. `open(recordingId, signal?)` grants a
`RecordingExport` session after canonical replay of the authoritative baseline and
all committed changes through its head. Derived checkpoints are ignored. The
worker retains one read-only SQLite transaction until the session closes, so
concurrent appends, rename, deletion or recreation cannot mix versions into the
export. Files are never created or migrated by this reader.

`exportRecording(session, signal, limits?)` returns an async byte generator. The
caller owns the pinned session and must close it even if no generator iteration
starts. For Node output, use `pipeline` to a bounded writable stream and supply the
same signal. The caller also owns file creation and cleanup of failed partial
output; this stream API does not yet provide a CLI's atomic output-file workflow.
A partial stream cannot pass import framing validation without its complete trailer.

Export providers allow two simultaneous sessions by default (configurable 1–4),
including pending opens. Provider closure cancels all owned workers. Cancellation
also interrupts startup replay by terminating its worker. Pinned snapshots can
retain local SQLite WAL while other local writers run, so close sessions promptly and
bound output I/O. This is a different lifetime from selected-state reconstruction,
which releases the database snapshot before serving reconstructed rows.

## Import publication

`importRecording(byteSource, destination, signal, limits?)` consumes nonempty byte
chunks and returns the imported `RecordingInfo`. The destination implements the
public `HistoryImports` contract. The local implementation is described in
`docs/import-staging.md`.

Manifest decoding and declared frame-count checks precede staging acquisition.
The importer verifies the projection fingerprint, baseline key order/checksum,
record counts, references, transaction predecessors and final head. Bounded
baseline batches and whole commits go to isolated staging. Normal EOF after the
verified framing trailer is required before publication. The destination then
revalidates full authoritative replay and commits the history atomically.

A recording exported while active imports as `interrupted`; stopped, interrupted
and published-invalid lifecycles are retained. Existing local IDs are rejected,
never replaced. Checkpoints, source bindings and local writer claims are not
transferred. Import grants no authority to resume capture or clean up source
resources. Close/error paths remove staging without deleting existing history.

Both operations apply the physical framing limits. Declared counts are capped at
1,000,000 baseline rows and 100,000 transactions; the manifest plus all data records
must also fit the selected framing record limit. Aggregate event work is capped at
1,000,000. Import staging and export replay apply configured state/disk budgets as
well. The transport never accumulates all transactions in memory. Input adapters
must own pending I/O and observe cancellation; lazy input acquisition avoids
opening a file when the operation is already cancelled.

## Evidence and remaining scope

Tests write an actual file through a stream pipeline, close the source store,
import in a fresh destination and reopen exact historical states offline. They
cover key-changing multi-event commits, microsecond commit time, exact int8,
numeric, JSON numbers and bytes, UTF-8 key ordering, pinned export during source
append/deletion, empty history and duplicate destination IDs.

Valid-framing semantic corruption, an invalid final trailer and pre-trailer
cancellation leave existing recordings unchanged and remove staging. A derived
checkpoint fixture exceeds 1,000 corrupt candidates: the ordinary checkpoint
restore path hits its work bound while authoritative export still succeeds.
Session capacity, cancellation and closure are also exercised.

The full project goal remains incomplete. This format does not yet carry optional
application context or column-policy provenance. CLI file workflows, share-safe
policy-derived exports, broader adapter conformance/packaged consumers and the
remaining query, invariant and browser requirements still need implementation and
acceptance evidence.
