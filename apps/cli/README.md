# CLI (`oathpath`)

First-party command-line client for the API. It authenticates with the same
device authorization flow as any other headless client, stores a personal
access token, and then lets you call any API endpoint from a shell — which
matters because this repository is a **baseline**: new endpoints get added
and old ones get renamed constantly, and a CLI that hard-codes a subcommand
per resource goes stale the day it ships. `oathpath` has exactly one command
that talks to the API (`api <method> <path>`), so it stays correct against
endpoints that don't exist yet.

Run with no arguments in an interactive terminal and it opens a full-screen
menu (login, call an endpoint, view config, deploy this server, logout) built
with [ink](https://github.com/vadimdemedes/ink). Everything that menu can do
is also a plain subcommand, and the subcommands are what this document
covers — they're what you'd script or run in CI.

## Install

There's no published package; the installer builds `oathpath` from this repo
and deploys a standalone copy — you don't need a local clone to end up with
a working `oathpath` on your PATH.

```bash
curl -fsSL https://raw.githubusercontent.com/marinoscar/oathpath/main/install.sh | bash
```

It's safe to re-run: the installer detects an existing install at
`~/.oathpath/app`, shows the old → new version transition, and updates it in
place — the same command is also how you update.

### Install from a local clone

If you already have the repo checked out (or want to test the installer
itself without a network round-trip), point it at that directory with
`OATHPATH_SRC` instead of letting it `git clone`:

```bash
OATHPATH_SRC=/path/to/repo bash /path/to/repo/install.sh
```

### Update

Re-run the same command you installed with — the curl one-liner above, or
the `OATHPATH_SRC` form for a local clone. Either way the installer detects
the existing install and updates it in place.

### Uninstall

```bash
curl -fsSL https://raw.githubusercontent.com/marinoscar/oathpath/main/install.sh | bash -s -- --uninstall
```

or, from a local clone:

```bash
bash install.sh --uninstall
```

This removes the installed app directory (`~/.oathpath/app`) and the `oathpath`
shim (`~/.local/bin/oathpath` by default). It leaves
`~/.oathpath/config.json` — your stored server URL and credentials — untouched;
uninstalling doesn't log you out.

### Requirements

The installer checks for these before doing anything else:

| Tool | Version | Notes |
| --- | --- | --- |
| `node` | >= 20 | apps/cli's own `engines.node` floor |
| `npm` | any | ships with Node.js |
| `git` | any | only needed unless you use `OATHPATH_SRC` |
| `curl` | any | only needed for the piped one-liner |

apps/cli has no native modules, so there's no C-compiler / build-toolchain
requirement — just these four.

### What the installer does

1. Checks dependencies (`node`, `npm`, `git`, `curl`; warns, but doesn't
   fail, on low disk space).
2. Gets the source — either `git clone --depth 1` of `OATHPATH_REPO` at
   `OATHPATH_REF`, or a copy of `OATHPATH_SRC` if set — into a temp directory
   that's cleaned up on exit.
3. Builds the CLI workspace: `npm install --workspace=cli` then
   `npm run build --workspace=cli`, from that temp checkout.
4. Deploys the standalone app: copies `apps/cli/dist`, `package.json` and
   `README.md` into `~/.oathpath/app` (replacing any previous install), then
   runs `npm install --omit=dev` there to pull in just the runtime
   dependencies (commander, ink, ink-select-input, ink-spinner,
   ink-text-input, react).
5. Writes the `oathpath` shim to `~/.local/bin/oathpath` — a small script that
   `exec`s `node ~/.oathpath/app/dist/cli.js "$@"` — and makes it executable.
6. Checks whether the shim's directory is on `$PATH` and, if not, prints the
   `export` line to add to your shell config (see below).
7. Verifies the install by running the new shim's `--version` and printing
   an install summary (version, install size, paths).

If `~/.local/bin` (or your custom `OATHPATH_BIN_DIR`) isn't on `$PATH`, add
this to `~/.bashrc` or `~/.zshrc` and reload your shell:

```bash
export PATH="$PATH:$HOME/.local/bin"
```

(On WSL specifically, the installer prints a dedicated box with the exact
two commands to run, since `~/.local/bin` is rarely on `$PATH` there by
default.)

### Installer environment variables

Set these before running the installer to override its defaults:

| Variable | Default | Purpose |
| --- | --- | --- |
| `OATHPATH_REPO` | `https://github.com/marinoscar/oathpath.git` | Git clone URL |
| `OATHPATH_REF` | `main` | Branch/tag/commit to install |
| `OATHPATH_HOME` | `$HOME/.oathpath` | App install root (same directory the CLI stores `config.json` in) |
| `OATHPATH_BIN_DIR` | `$HOME/.local/bin` | Directory for the `oathpath` shim |
| `GITHUB_TOKEN` | (unset) | Optional GitHub PAT, for cloning a private repo |
| `OATHPATH_SRC` | (unset) | Local directory to install from instead of cloning |

`NO_COLOR` and the installer's own `--no-color` flag both disable ANSI
colour in its output.

## Logging in

```bash
oathpath login
```

This runs the device authorization flow (RFC 8628) — the same "open this URL
and enter this code" flow you'd use for the CLI on a smart TV. It:

1. Requests a device code and user code from the server.
2. Prints a short instruction panel with the verification URL and the code,
   and tries to open your default browser to it (skip that with
   `--no-browser`, which just prints the URL instead).
3. Polls the server until you approve the request in the browser (or it
   expires — RFC 8628's `authorization_pending` / `slow_down` / `expired_token`
   / `access_denied` outcomes all apply).
4. On approval, validates the issued credential against `GET /api/auth/me`
   and saves it — validating before saving means a bad or already-invalid
   credential never overwrites a working one already on disk.

The credential minted here is a **personal access token** (a `pat_...`
string), not a short-lived session JWT — that's what makes it practical to
stay logged in for days between commands. It's stored, along with the server
URL, in `~/.oathpath/config.json`. That file is created with `0600`
permissions (owner read/write only) even across restarts and partial
rewrites — see the extensive comment on `writeConfigFile` in
`apps/cli/src/config.ts` if you want the mechanics of how that's guaranteed
under a hostile umask. The token itself is never printed by any command; if
you need to see what's stored, `oathpath config` prints the server URL and a
masked hint (`pat_abcd••••••••` — the first eight characters, then a
fixed-width mask) instead.

`login --server <url>` skips the interactive prompt for the server. If you
already have a personal access token (minted from the web UI's Access Tokens
page, or from a previous device-flow login), `login --server <url> --token
pat_...` validates and stores it directly, skipping the device flow entirely
— useful for a one-off headless setup, though prefer the environment
variables below for anything that runs unattended and repeatedly. Passing a
token on the command line puts it in your shell history and in `ps` output
for other users on the machine, which is why the CLI warns about it after a
successful `--token` login.

There is deliberately no `oathpath logout` subcommand — logout only exists as
a screen in the interactive menu (`oathpath` with no arguments, then choose
Logout). It calls `DELETE /api/pat/{id}` to revoke the token on the server
*before* deleting the local file, on purpose: the PAT this CLI holds is
long-lived, so simply deleting the local copy would leave a fully valid,
unrevoked token that nobody can see is still active. If you're scripting and
need to invalidate a token, revoke it from the web UI's Access Tokens page
(`DELETE /api/pat/{id}` — the same call the TUI makes) — there is no headless
equivalent of the interactive logout.

## Calling the API

```bash
oathpath api GET /api/auth/me
```

`api` is the one command that talks to arbitrary endpoints. The response
body goes to stdout and nothing else does — status line, spinner and errors
all go to stderr — so a pipeline sees exactly the server's JSON:

```bash
oathpath api GET /api/users --raw | jq '.data[].email'
```

`--raw` prints compact, uncoloured JSON with a trailing newline and nothing
else on stdout; without it, the same body is pretty-printed with colour when
stdout is a terminal. Either way it's the server's response body verbatim —
not the unwrapped `data` field — because a paginated list's `data` +
`pagination` shape and a single resource wrapped by the API's
`TransformInterceptor` as `{ data, meta }` look identical from the outside,
and unwrapping one of them silently drops the pagination info.

Other flags, from `oathpath api --help`:

```
Arguments:
  method               HTTP method (GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS)
  path                 Request path, e.g. /api/auth/me

Options:
  --query <key=value>  Query parameter; repeat for more than one
  --data <json>        Request body: inline JSON, @file.json, or - for stdin
  --raw                Print unformatted JSON on stdout and nothing else
  -q, --quiet          Suppress the status line and spinner on stderr
  --no-color           Disable colour even on a terminal
  --timeout <ms>       Per-request timeout in milliseconds
```

The exit code is `0` only for a 2xx response; anything else exits non-zero
with the server's own error message, so `oathpath api ... || echo failed` (or
just relying on `set -e`) works the way you'd expect in a script. The `/api`
prefix is optional — `oathpath api GET /api/auth/me` and `oathpath api GET
/auth/me` request the same thing, since the client's base URL already ends
in `/api`.

## Deploying to a server

```bash
oathpath deploy doctor
```

Four subcommands (`doctor`, `install`, `update`, `status`) take this
repository — or, far more likely, your fork of it — from an empty VPS to
running, migrated, seeded, and served over HTTPS at a real domain, and back
to the latest revision on every subsequent deploy. They run **on the VPS
itself**: SSH in with your own credentials, build `oathpath` from a checkout
there (see [Building from source](#building-from-source-development) below),
and run these from inside it. There's no SSH client in `oathpath` and no
laptop-driven orchestration — it never dials out to a server on your behalf.

For the full walkthrough — prerequisites, the manual step after install,
troubleshooting — see [`docs/deployment/vps.md`](../../docs/deployment/vps.md).
For why it's built this way, see
[`docs/specs/vps-deploy.md`](../../docs/specs/vps-deploy.md).

### Checking prerequisites

```bash
oathpath deploy doctor
oathpath deploy doctor --domain app.example.com
```

Nothing is installed, written or started — it's read-only, so it's safe to
run against a production server at any time, not just before a first
install. It runs around 27 checks: Docker and its daemon, the Compose v2
plugin, git, node, disk and memory headroom, the loopback port, the shared
reverse proxy's directory and its `conf.d`/webroot being writable, certbot,
ports 80 and 443, the proxy's current config, the external PostgreSQL
database (reachable, credentials valid, database exists, can create tables,
TLS), and — once `--domain` turns them on — DNS and the certificate.

```bash
oathpath deploy doctor --json | jq '.checks[] | select(.status=="fail")'
```

Exits `6` (`EXIT.PRECONDITION`) when a required check fails, `0` when only
recommended checks fail — warnings never fail the run. `--json` prints a
machine-readable report on stdout and nothing on stderr.

Other flags, from `oathpath deploy doctor --help`:

```
Options:
  --root <path>        Deployment directory (default: "/opt/infra/apps")
  --proxy-root <path>  Shared reverse proxy directory (default:
                       "/opt/infra/proxy")
  --port <port>        Loopback port the proxy forwards to (default: "3535")
  --domain <domain>    Public domain; enables the DNS and TLS checks
  --json               Print a machine-readable report on stdout
  --no-color           Disable colour even on a terminal
```

`install` and `update` both run the same required checks as their own
preflight step, so nothing they do is skipped by running `doctor` first —
but running it on its own first means you find out about a bad DNS record or
an unreachable database before you're mid-pipeline, not partway through one.

### Installing

```bash
oathpath deploy install --domain app.example.com
```

Runs preflight → checkout → environment → validate-environment → build →
migrate → seed → start → health → publish → verify, in that order, printing
each step's result as it completes. `--domain` is the one required flag.

The repository and ref come from **this checkout's own git remote**, not a
value hardcoded in the CLI — a fork deploys itself with no configuration
change; see "Deploying a fork" below.

```bash
oathpath deploy install --domain app.example.com --staging
oathpath deploy install --non-interactive --domain app.example.com
```

Use `--staging` while you're still working out the setup — it requests a
Let's Encrypt **staging** certificate instead of a production one. Worth
doing before a first real attempt, because a failed production issuance
spends real rate-limit budget: five failures per hostname per hour, and 50
certificates per registered domain per week, shared with every subdomain on
that server. `--non-interactive` skips every prompt and fails, listing
what's unresolved, rather than asking; pair it with `--all` to review every
environment variable instead of only the essential dozen.

`install` is idempotent — if it fails partway through, fix whatever it
reported and run the same command again, or add `--resume` to continue from
the step that failed rather than re-running everything before it.
`--reinstall` installs over an existing deployment on purpose; `--force`
discards uncommitted changes in the checkout it manages; `--skip-doctor`,
`--skip-proxy` and `--skip-seed` each skip exactly the one stage they name.

Other flags, from `oathpath deploy install --help`:

```
Options:
  --root <path>        Deployment directory (default: "/opt/infra/apps")
  --domain <domain>    Public domain to publish under
  --proxy-root <path>  Shared reverse proxy directory (default:
                       "/opt/infra/proxy")
  --port <port>        Loopback port the proxy forwards to (default: "3535")
  --repo <url>         Repository to deploy (default: this checkout's origin)
  --ref <ref>          Branch, tag or commit (default: the remote default
                       branch)
  --email <email>      Certificate registration address
  --group <name>       Optional feature group; repeat for more (default: [])
  --all                Review every environment variable, not only the essential
                       ones
  --non-interactive    Never prompt; fail listing anything unresolved
  --reinstall          Install over an existing deployment
  --resume             Continue from the step that failed
  --skip-doctor        Skip the prerequisite checks
  --skip-proxy         Do not touch the reverse proxy or request a certificate
  --skip-seed          Do not run the database seed
  --no-cache           Rebuild images without the layer cache
  --force              Discard uncommitted changes in the checkout
  --staging            Use Let's Encrypt staging while working out the setup
  --json               Print a machine-readable result on stdout
```

**`install` does not create an admin user.** The seed writes the allowlist
row for `INITIAL_ADMIN_EMAIL`, not a user account — nobody has access until
that address logs in through Google OAuth at `https://<domain>`. See "After
install: the first login" in the runbook linked above.

### Deploying a fork

You don't need to change anything in this CLI to deploy a fork. The
repository URL and ref are read from your own checkout's git remote (a fork
using `master` or `develop` as its default branch works with no `--ref`
needed — nothing here assumes `main`), and the environment wizard's
questions are parsed structurally from *your fork's own*
`infra/compose/.env.example`, not a list of field names hardcoded into the
CLI. Rename the app, add a new secret to your `.env.example`, remove a
feature block: `oathpath deploy install` follows all of it with no flag
changes, for the same reason `api <method> <path>` (above) doesn't go stale
as endpoints change — nothing about a specific repository's shape is baked
into the tool.

### Updating

```bash
oathpath deploy update
```

Brings an already-installed server up to the latest revision (or, with
`--ref`, to a specific one): fetch, build, migrate, seed, restart, verify.
It refuses to run at all if nothing is installed at `--root` yet.

```bash
oathpath deploy update --ref v1.4.0
```

If the resolved ref's commit hasn't moved since the last successful run,
`update` exits `0` **without doing anything** — no rebuild, no restart —
which is what makes it safe to run unattended, e.g. from cron. `--force`
rebuilds anyway even when the revision is unchanged.

The database seed **re-runs by default** on every `update`. The seed is
entirely upserts, and re-running it is the only way a permission or role a
newer release adds actually reaches an already-installed server — skip it
and the feature ships, the permission doesn't exist, and it shows up later
as a confusing 403 with nothing in the logs to explain it. This is a
deliberate divergence from the shell scripts this replaces, which never
re-seeded; pass `--skip-seed` if you've hand-edited seeded rows and don't
want them upserted back.

There's no automatic rollback. A partly-applied database migration can't be
undone by checking out the old code, so on failure `update` prints the
previous revision and the exact command to redeploy it —
`oathpath deploy update --ref <sha> --force` — and leaves that decision to you.

Other flags, from `oathpath deploy update --help`:

```
Options:
  --root <path>      Deployment directory (default: "/opt/infra/apps")
  --ref <ref>        Branch, tag or commit to move to
  --force            Rebuild even when the revision has not changed
  --no-cache         Rebuild images without the layer cache
  --non-interactive  Never prompt; fail listing anything unresolved
  --skip-seed        Do not re-run the database seed
  --skip-proxy       Do not touch the reverse proxy
  --json             Print a machine-readable result on stdout
```

### Checking status

```bash
oathpath deploy status
```

Reports whether the deployment at `--root` is healthy: container state, an
immediate `/api/health/ready` poll, migration state, and — with `--domain` —
an external HTTPS check.

```bash
oathpath deploy status --domain app.example.com
oathpath deploy status --json || alert 'deployment unhealthy'
```

`/api/health/ready` returning 200 only proves the app can run `SELECT 1`
against the database — it passes against a completely empty, unmigrated one
just as readily as a fully migrated one. That's why `status` reports
migration state as its own fact rather than inferring it from the health
probe.

Exits `0` when serving and the schema is current, `1` when installed but
unhealthy, `2` when nothing is installed at `--root`.

Other flags, from `oathpath deploy status --help`:

```
Options:
  --root <path>      Deployment directory (default: "/opt/infra/apps")
  --port <port>      Loopback port the proxy forwards to (default: "3535")
  --domain <domain>  Public domain; adds an external HTTPS check
  --json             Print a machine-readable report on stdout
  --no-color         Disable colour even on a terminal
```

### Logs

Every `doctor`, `install` and `update` run writes a human-readable `.log`
and a matching machine-readable `.jsonl` under `<deployRoot>/logs/`, mode
`0600`, newest ten runs kept. Every value the CLI knows to be a secret —
whether you typed it or the wizard generated it — is redacted from both
files before a single byte reaches disk, so they're safe to attach to an
issue or hand to someone else for help.

## CI usage

In CI there's no browser to complete the device flow in and no persistent
home directory to have logged in from earlier, so skip `login` entirely and
set:

```bash
export OATHPATH_SERVER_URL=https://app.example.com
export OATHPATH_TOKEN=pat_...
```

The environment always wins over `~/.oathpath/config.json` when both are
present, specifically so a pipeline's service token can't be shadowed by
whatever a developer happens to have logged in as on a shared runner.

Create and revoke the token itself from the web UI's **Access Tokens** page
(under user settings) — there's no CLI command to mint a PAT out of thin air
for CI use; the device flow is how the CLI gets one for a human logging in
interactively.

`oathpath` also refuses to launch its interactive menu unless stdout and stdin
are both real terminals, `TERM` is set to something other than `dumb`, and
neither `CI` nor `CONTINUOUS_INTEGRATION` is set — so `oathpath api ...` in a
pipeline behaves identically whether or not those variables happen to be
set. If you need to force that refusal in an environment that looks like a
terminal but isn't one you want to interact with, set `OATHPATH_NO_TUI` to
any truthy value (anything except empty, `0`, `false`, or `no`); every
explicit subcommand ignores this gate entirely and is unaffected by it.

## Renaming this for a fork

There are two identities here, and they are deliberately independent.

**The product name** — the "OathPath" half of the `OathPath CLI`
banner in `--help` and the interactive UI — is not set in this package at all.
It comes from the shared constant every app renders, so renaming the product
renames the CLI banner, the browser wordmark and the email templates together:

```js
// packages/shared/index.js
exports.APP_NAME = 'OathPath';
```

**The executable's own identity** — the command name shown in `--help` and
errors, the config directory (`~/.oathpath/`), and the `OATHPATH_`
environment-variable prefix — is derived from a separate constant:

```ts
// apps/cli/src/branding.ts
export const CLI_NAME = 'oathpath';
```

The split is intentional: a product called "Acme" may perfectly well still
ship a command called `oathpath`, and renaming the binary moves a filesystem
path and an environment-variable prefix, which renaming the product must not.

Change that one line (see the comment above it in `branding.ts` for the
naming constraints — lowercase ASCII letters, digits and hyphens only, since
it becomes both a filesystem path and part of an environment variable name)
and the config directory, the env var prefix, and every place the CLI refers
to itself by name follow automatically. The one place it can't reach is the
`bin` key in `apps/cli/package.json` — npm reads that before any of this
code runs, so it has to be updated by hand to match, and a test in
`apps/cli/src/branding.test.ts` asserts the two stay in sync.

Note that the env var prefix is `OATHPATH_`, not `APP_` — a bare `APP_` prefix
is generic enough to collide with unrelated variables in a shared CI shell,
so the prefix is derived from the (longer, more specific) binary name
instead. If you've seen `APP_SERVER_URL` / `APP_TOKEN` mentioned elsewhere,
that's what it would have been under a shorter, collision-prone prefix;
`OATHPATH_SERVER_URL` / `OATHPATH_TOKEN` is what the code actually reads.

`install.sh`'s default `OATHPATH_REPO` (the git URL it clones when
`OATHPATH_SRC` isn't set) is a second place a fork has to edit by hand,
alongside the `bin` key above. It's a standalone shell script that runs
*before* any of this repo's own code executes — `git clone`s the source
first — so it has no way to read `CLI_NAME` out of `branding.ts` and derive
the clone URL itself; the URL is hard-coded near the top of `install.sh`
under its own "Defaults" comment block and has to be changed there directly.

## Building from source (development)

The install path above is for end users. If you're developing the CLI
itself inside this monorepo, build and run it from the workspace instead:

```bash
# from the repo root, after the workspace's node_modules are installed
npm run build --workspace=cli
```

This runs `tsc` against `apps/cli/tsconfig.build.json`, emitting
`apps/cli/dist/`, and marks `dist/cli.js` executable. From there you can run
it straight from the workspace without installing or publishing anything:

```bash
node apps/cli/dist/cli.js --help
```

or, from inside `apps/cli`:

```bash
node dist/cli.js --help
```

If you want the bare `oathpath` command on your PATH without publishing, `npm
link` from `apps/cli` (`package.json`'s `bin` field maps `oathpath` to
`./dist/cli.js`) does that using the standard npm mechanism.

For iterating on the CLI's own source without rebuilding on every change,
`npm run dev --workspace=cli` runs `tsx src/cli.ts` directly — same behavior,
no build step.

## Running tests

```bash
npm run test:run --workspace=cli
```
