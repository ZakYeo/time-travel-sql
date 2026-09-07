# Recorder process crash recovery

The native fixture starts a recorder in its own Node process using public resume,
PostgreSQL and SQLite adapters. Test-only IPC barriers pause immediately before
append, after the worker confirms durable append but before acknowledgement, and
after acknowledgement. The parent sends SIGKILL and waits for process termination;
no session stop, status update, writer release or connection cleanup runs in the
recorder. PostgreSQL observes socket closure and releases its advisory locks.

At the first two barriers, the retained slot's confirmed position still equals the
baseline. At the third, bounded polling observes acknowledgement at the committed
end position before termination. Reopened SQLite contains either the untouched
baseline or the complete committed transaction, with matching durable progress.
The abandoned local writer generation does not prevent a fresh resume.

Each case starts with a nonempty baseline, crashes around a commit containing a
primary-key update and insert, and adds a delete/insert commit while the recorder
is down. Resume uses the existing slot and saved binding. Final history contains
exactly two complete commits and reconstructed rows match independently queried
source SQL. The slot remains present after normal stop.

These cases prove process termination and restart at the three named boundaries.
They do not simulate power loss, filesystem corruption, or termination inside a
SQLite write transaction. Nor do they force redelivery of an already persisted
commit: resume requests the durable end position. Separate native source-stream
and duplicate-append tests cover retained unconfirmed delivery and idempotence.
Automatic reconnect after a transient source failure remains separate work.

The harness accepts only the connection supplied by its newly created private
PostgreSQL cluster; it never reads an ambient DATABASE_URL. IPC waits have a fixed
deadline, polling is bounded, and the owner kills only its own child process.
Process cleanup settles on close, including failed process startup.
