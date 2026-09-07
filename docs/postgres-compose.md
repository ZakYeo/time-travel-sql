# Disposable PostgreSQL Compose fixture

Run `npm run test:compose` with the pinned Node runtime, Docker Engine and Docker
Compose installed. The command builds the workspace and runs one live capture smoke
against the digest-pinned official PostgreSQL 16.15 image in `compose.postgres.yml`.
The test checks the actual server version and logical WAL configuration, captures a
transaction through public APIs, and compares reconstructed rows with source SQL.

The harness creates a fresh `tts-test-<uuid>` project for every invocation and finds
its dynamically assigned loopback port. The database/user are `tts_dev`; the public
password `tts_disposable_local_only` is only for this disposable local fixture.
The project's database volume is removed during teardown.

Docker uses an explicit local Unix socket, `/var/run/docker.sock` by default. Set
`TTS_DOCKER_SOCKET` to an absolute local socket path when needed. An owned temporary
Docker client configuration prevents ambient contexts and registry credentials from
being selected; `DOCKER_HOST` does not redirect the fixture. No ambient database
connection is used.

Startup has a 60-second readiness deadline and a 120-second command deadline. Port
lookup allows 10 seconds; teardown allows 30 seconds, including a 10-second service
stop timeout. Teardown targets only the generated project and its volumes. Every
registered client/local-store cleanup is attempted, preserving workload and cleanup
errors together. A killed test runner can still leave its project behind; an error
from teardown identifies the project for inspection and scoped removal.

The live smoke passed locally with authorized integration execution permissions.
The restricted command context initially denied Docker socket access; that denial
was not evidence that the fixture could not run. CI has a separate Compose job,
which is configured but not claimed executed here.

`npm run test:integration` remains the broader 62-case native PostgreSQL suite,
using isolated temporary clusters. The single Compose smoke does not imply all
native scenarios were rerun under Docker. Five unit tests separately exercise the
harness's command scoping and failure cleanup through a fake executable.
