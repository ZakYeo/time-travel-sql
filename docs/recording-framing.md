# Recording transport framing, version 1

`@time-travel-sql/exchange` supplies the Node byte transport for portable recordings.
It depends only on the public SDK and Node built-ins; the SDK remains independent.
This is the physical framing contract; `docs/portable-recordings.md` describes
the semantic manifest and import service built on it. Successful framing verification does not prove schema, references,
transaction continuity, replay correctness or recording completeness.

## Wire contract

One uncompressed UTF-8 stream contains these LF-terminated JSON lines in order:

1. Exactly `{"format":"time-travel-sql-frames","version":1}`.
2. Zero or more `{"record":<canonical JSON value>}` lines.
3. Exactly `{"end":<record count>,"sha256":"<lowercase hex digest>"}`.

The SHA-256 digest covers the exact header and data line bytes, including every LF.
It excludes the trailer. The count excludes the header and trailer. EOF must follow
the trailer's LF; additional bytes, missing lines/newlines, blank lines, CRLF, BOM,
invalid UTF-8, extra frame fields and other versions fail. This digest detects
corruption and is not an authenticity guarantee.

Each JSON line must match `JSON.stringify(JSON.parse(line))` exactly. This spelling
rule rejects duplicate object keys, extra whitespace, alternate escape spellings
and numbers that change on parsing. It preserves insertion order for non-index
object keys; it is not a sorted-key JSON canonicalization standard. Exact database
numbers remain strings in the canonical SDK value model. The transport does not
validate those domain values, and callers must not infer safe numeric semantics
from successful JSON parsing alone.

`encodeRecordingFrames` accepts an asynchronous sequence of canonical JSON strings,
avoiding implicit execution of caller objects' getters or `toJSON` methods. It
validates each input and emits byte chunks. `decodeRecordingFrames` accepts an
asynchronous sequence of nonempty byte chunks and yields `unknown` values. Chunk
boundaries have no wire meaning, and UTF-8 code points may cross them. Empty chunks
are rejected so zero-byte inputs cannot bypass the aggregate work bound.

## Bounds and ownership

Defaults are also hard ceilings; callers can supply smaller positive safe integers:

| Limit                  | Ceiling               |
| ---------------------- | --------------------- |
| Bytes per line         | 18 MiB, excluding LF  |
| Total bytes            | 512 MiB, including LF |
| Data records           | 1,000,000             |
| JSON container depth   | 64, including frame   |
| Structural tokens/line | 1,000,000             |

The structural scan counts opening containers, colons and commas outside strings
before calling `JSON.parse`. This bounds graph allocation as well as nesting.
A reusable line buffer avoids accumulating the recording or repeatedly copying
partial lines. Total byte accounting includes all input bytes, even a chunk that
contains data after the trailer. Limits bound encoded content and parser work,
not an exact process-heap estimate. The incoming chunk is owned by the source;
source I/O must also be bounded when integrating file/network adapters.

Both generators check the supplied abort signal between bounded records/chunks,
including before the first source pull. Iterator cleanup propagates to the source
on failure or early return. The source owns pending I/O and must observe the same
signal; these APIs cannot interrupt an arbitrary non-cooperating pending `next()`.
Buffered input yields to the Node event loop after at most 64 KiB of byte work
or 256 framing steps, so timer/I/O aborts can run even when the source never waits.
A single bounded line can exceed that byte interval; its synchronous JSON work
still completes before another event-loop abort can be observed.

Data may be yielded before the checksum trailer arrives. Consumers must stage it,
perform canonical domain validation, and exhaust the stream normally before any
atomic publication. Early return is not verification. No API in this package
publishes a recording or writes to an existing workspace.

## Evidence and remaining work

Independent wire fixtures verify encoder bytes and decoder behavior across every
split, including single-byte chunks and Unicode boundaries. Tests cover malformed
framing/UTF-8, checksum/count corruption, JSON ambiguity, bounds, cancellation and
source iterator cleanup. The semantic manifest and atomic import service are now integrated; see
`docs/portable-recordings.md` for the real-file round-trip evidence and remaining
context/policy and CLI requirements.
