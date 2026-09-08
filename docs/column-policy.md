# Recorded column policy

Source configuration accepts an optional deterministic policy:

```json
{
  "columnPolicy": {
    "version": 1,
    "rules": [
      {
        "namespace": "public",
        "table": "orders",
        "column": "email",
        "action": "redact"
      },
      {
        "namespace": "public",
        "table": "orders",
        "column": "notes",
        "action": "exclude"
      }
    ]
  }
}
```

Rules address exact selected columns. Duplicate rules, missing columns and protected
primary keys are rejected. Setup validates policy inside its transaction, so invalid
policy rolls back publication and replica-identity changes. Doctor reports `lossy`
when any column is protected. Omitted policy retains every column for a new recording.

Snapshot and change decoding replace protected values before persistence with
`{ "kind": "unavailable", "reason": "redacted" }` or the corresponding `excluded`
token. This includes SQL NULL and unchanged TOAST; original nullness is not retained.
Column names and types remain in the schema. Protected columns cannot participate
in historical SQL, including empty-table queries and whole-row reads. Available
columns and row counts remain queryable.

Canonical column metadata stores `capture: "redacted"` or `capture: "excluded"`.
It participates in the portable manifest's schema fingerprint. Storage, replay
and import reject values that violate declared policy; they cannot silently accept
unmasked values. The SDK exposes `applyColumnPolicy` and `projectRow` for explicit
adapter projection. Applying a policy does not recover previously lost values.

The capture binding pins the canonical policy to the recording. CLI resume requires
the same policy and rejects mismatches before reserving its writer. SDK resume
preflight inherits omitted policy from recorded metadata and rejects an explicit
change. A different projection requires a new recording. Old recordings without
policy metadata retain their existing representation and fingerprint.

Source transport still receives bounded raw frames before adapter projection.
Export preserves the declared loss, schema and available data; it does not promise
anonymity or remove identifying information from other columns.

## Derived sharing workflow

Use a separate policy file containing `{ "version": 1, "rules": [...] }` with the
same rules above. This command requires a new recording ID and an explicit name:

```sh
tts export-derived original-id ./shared.tts shared-id 'Shared investigation' ./policy.json --workspace ./history --json
tts init --workspace ./fresh
tts import ./shared.tts --workspace ./fresh --json
tts query shared-id baseline 'SELECT id FROM public.orders' --workspace ./fresh --json
```

The command validates the entire original history before producing projected data,
including stale before-images that masking could otherwise conceal. It preserves
table/row identities, key changes, event order, committed positions and coverage.
It recomputes the baseline commitment and configuration fingerprint. File publication
is exclusive, synced and mode 0600 on supported systems; cancellation, corruption
and an existing destination do not publish or replace a file. The original recording
is unchanged, and raw source values are never staged in an intermediate file.

Derived schema metadata declares `committed-replay`, `row-history` and
`available-column-sql` capabilities, the parent configuration fingerprint and
`liveResume: false`. These declarations survive import and subsequent export.
The canonical resume boundary rejects derived recordings. Saved SQL definitions,
source ownership bindings and credentials are not part of portable history.
The fingerprint identifies parent configuration, not a signed provenance or a
commitment to every parent history byte. Existing restrictions are retained when
deriving again. Names, keys, available columns and transaction metadata still carry
their recorded information; choosing a policy does not establish anonymity.

The exchange API exposes `prepareDerivedRecording`, returning a borrowed
`RecordingExportView` for `exportRecording`. Its caller owns the pinned source
session and closes it. `exportRecordingFile` accepts optional derivation options
and owns its opened session through publication. Stalled borrowed reads settle on
cancellation without closing the caller's source; late rejections are observed.
The caller still owns any outstanding provider work.

Preparation and output each enforce exchange byte/frame limits. Original replay
uses canonical state bounds of 100000 rows and 64 MiB, with one transaction per
page. Baseline validation is incremental and yields every 64 KiB or 256 records.
Commit replay remains atomic within the existing per-transaction limits. These
are logical work/state limits, not a process RSS guarantee.
