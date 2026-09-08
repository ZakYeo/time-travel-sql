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
anonymity or remove identifying information from other columns. A separate derived
share-safe export workflow remains pending.
