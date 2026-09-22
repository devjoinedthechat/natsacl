# natsacl

**Least-privilege NATS permissions, compiled from your TypeScript.**

`natsacl` reads the code that publishes, requests, subscribes and consumes, and emits one broker user per service with exactly the subjects that code touches — as a `nats-server` config block, an `nsc` script, or JWT permission JSON. A CI gate fails the build when the checked-in permissions drift from what the code implies, and a coverage check fails it when a JetStream consumer's filter subject falls outside every provisioned stream.

```
$ natsacl compile
wrote nats/auth.conf (server, 2 user(s))

$ natsacl explain alerts-svc INCIDENTS.opened
alerts-svc may publish INCIDENTS.opened via "INCIDENTS.opened"
  js-publish "INCIDENTS.opened" at src/alerts/incidents.ts:19:11 [type]
alerts-svc may NOT subscribe INCIDENTS.opened
```

[![ci](https://github.com/devjoinedthechat/natsacl/actions/workflows/ci.yml/badge.svg)](https://github.com/devjoinedthechat/natsacl/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/natsacl)](https://www.npmjs.com/package/natsacl)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

---

## Why

A shared NATS credential lets any pod publish any subject. One compromised or merely buggy service can forge another service's events, drain a command bus, or delete a stream. NATS has fine-grained permissions to prevent that — but they are hand-written, so they drift from the code within weeks, and the first symptom of drift is a permissions violation on a live message.

There is no tooling that derives those permissions from the code. `nsc`, the Terraform provider and the control planes all manage credentials you author by hand; IAM policy generators observe traffic instead of reading source. `natsacl` closes that gap for TypeScript: the permission file becomes a build artifact, and the diff between it and the code becomes a CI failure.

The second thing it closes is subtler. JetStream does not enforce subscribe permissions on consumer filters ([nats-server#3202](https://github.com/nats-io/nats-server/issues/3202)); the only boundary is the consumer-creation API subject, which embeds the filter. `natsacl` scopes every `$JS.API.CONSUMER.CREATE` grant to the exact filter the code subscribes with, and checks that filter against the streams you provision — because a filter outside a stream's subjects is rejected at consumer creation, usually inside a caught handler, leaving a healthy-looking service with a dead subscriber.

## Install

```sh
npm install --save-dev natsacl typescript
```

Node 20+. TypeScript 5+ is a peer dependency; the analysis runs on your project's own `tsconfig.json`.

## Quick start

```sh
npx natsacl init            # writes natsacl.config.json
```

```jsonc
// natsacl.config.json
{
  "services": [
    { "name": "ingest", "entry": "src/ingest/main.ts" },
    { "name": "alerts", "entry": "src/alerts/main.ts" }
  ],
  "streams": "from-code",                          // or [{ name, subjects }], or { file }
  "output": { "format": "server", "file": "nats/auth.conf" }
}
```

```sh
npx natsacl compile          # writes nats/auth.conf
npx natsacl check            # CI: exit 1 if nats/auth.conf differs from what the code implies
npx natsacl lint             # dead subjects, uncovered filters, over-broad grants
```

Include the generated file from your server config:

```
# nats-server.conf
jetstream: enabled
include "auth.conf"
```

A single-service project needs no `services` list: every file in the program belongs to one user named after `package.json`.

The [`examples/ingest-alerts`](./examples/ingest-alerts) project shows two services sharing a base subscriber class; its [generated `auth.conf`](./examples/ingest-alerts/nats/auth.conf) is what CI checks on every push to this repository.

## How it works

1. **Parse.** The project is loaded as a real TypeScript program with the type checker, so imports, barrels, aliases, overloads, interfaces and class hierarchies resolve the way `tsc` resolves them.
2. **Match.** Every call is matched against a table of *shapes* — which method on which receiver type is a publish, a request, a subscribe, a JetStream consumer creation, and which argument carries the subject, stream and durable name. The built-in table covers the official `nats` and `@nats-io/*` clients; your own wrappers are declared in config or with a `@natsacl` JSDoc tag.
3. **Evaluate.** The subject argument is evaluated to a finite set of NATS patterns:
   - string literals, `as const` objects, enums, constants across modules;
   - template literals, `+`, `[…].join('.')`, ternaries, `??` and `||`;
   - string-literal union types and template-literal types on parameters and properties;
   - records indexed by a dynamic key (every member), and pure string transforms over a finite set (`toLowerCase`, `replace` with literal arguments);
   - functions that return subjects, inlined with their arguments bound;
   - **wrapper parameters**, evaluated at every call site of the wrapper — including calls through the interfaces and base classes it implements;
   - **abstract or uninitialised properties**, evaluated at every subclass that initialises them, so a base class calling `this.nats.subscribe(this.subject)` yields one fact per concrete subscriber.
4. **Attribute.** A fact belongs to a service when the file performing the call, and every file its value travelled through, is reachable through imports from that service's entry. A shared library's subscriber base class is granted only to the services whose subclasses use it.
5. **Derive.** Facts become grants (table below), lists are minimised (`SENSORS.reading` is dropped when `SENSORS.>` is present), and every grant keeps the call sites that justify it.
6. **Check.** Filters are verified against provisioned streams; the rendered output is compared with the checked-in file.

### What the evaluator refuses

The compiler may under-grant, never over-grant. When a subject cannot be pinned down it fails with the file, line and reason instead of emitting `>`:

| Situation | Result |
|---|---|
| `` `SENSORS.${id}` `` — a dynamic value that fills a whole token | `SENSORS.*` |
| `` `DEVICE-${id}` `` — a dynamic value inside a token | **error** `partial-token` (NATS wildcards match whole tokens; `widenPartialTokens` grants `*` and reports it) |
| `publish(subject)` where `subject` is a parameter nothing in the program calls with a resolvable value | **error** `no-callers` |
| `publish(process.env.SUBJECT)` | **error** `dynamic` |
| `` `${a}.${b}` `` with no literal token at all | **error** `dynamic` |

Every error names the fix: declare the pattern with a comment on the call, an `overrides` entry, or a `@natsacl` tag on the wrapper. Overrides are reported in the output so a reviewer can see every place the ACL trusts a human instead of the code.

```ts
// natsacl-subject: SENSORS.legacy.>
this.nc.publish(buildLegacySubject(), payload);
```

### What a consumer needs

| The code does | User may publish | User may subscribe |
|---|---|---|
| `nc.publish('A.B')` | `A.B` | |
| `nc.request('A.B')` | `A.B` | `_INBOX.>` |
| `nc.subscribe('A.B')` | | `A.B` |
| `msg.respond()` | `allow_responses: true` | |
| `js.publish('A.B')` | `A.B`, `$JS.API.INFO` | `_INBOX.>` |
| `js.pullSubscribe('A.B', { stream: 'S', config: { durable_name: 'D' } })` | `$JS.API.CONSUMER.CREATE.S.D.A.B`, `$JS.API.CONSUMER.INFO.S.D`, `$JS.API.CONSUMER.MSG.NEXT.S.D`, `$JS.ACK.S.D.>`, `$JS.API.STREAM.INFO.S` | `_INBOX.>` |
| `jsm.consumers.add('S', { durable_name: 'D', filter_subject: 'A.>' })` | as above, with filter `A.>` | `_INBOX.>` |
| `js.consumers.get('S', 'D')` | `INFO`, `MSG.NEXT`, `$JS.ACK.S.D.>` | `_INBOX.>` |
| stream not named in code | inferred from provisioned streams by filter coverage; `$JS.API.STREAM.NAMES` added because the client looks it up | |
| durable not a literal | `*` for the consumer token, reported as `consumer-wide-grant` | |
| unnamed (ephemeral / ordered) consumer | `*` for the consumer token, plus `CONSUMER.DELETE` | |
| `jsm.streams.add(…)` inside a service | **nothing** — reported as `stream-admin-in-service`; streams are provisioned by the `admin` user | |

Set `jetstream.api: "legacy"` to also grant `$JS.API.CONSUMER.DURABLE.CREATE` for servers before 2.9.

## Validation on a real codebase

Before release the compiler was run over a 14-service TypeScript monorepo (a shared library of about 1,800 files plus the services; roughly 1,300 files reachable per service) that already maintained a hand-written per-service NATS permissions file. The whole backend compiles in about eleven seconds.

- Consumer-creation grants agreed with the hand-maintained file on 392 of 402 entries. The remaining ten came from wrapper types the validation config had not declared, which `shape-unused` and `explain` make visible.
- For one service, 37 of its 49 consumer grants were scoped to the literal durable name the code uses; the hand-maintained file used `*` for every one.
- Eight literal subjects replaced one `PREFIX.>` wildcard where a union type enumerated the exact set the code could publish.
- Every subject the compiler could not resolve was reported with its call site; there were none left after three `${service}` overrides for a command bus built from the runtime service name.

## Configuration

`natsacl.config.json` (or `.js` / `.mjs` exporting `defineConfig({...})`). A [JSON schema](./schema/natsacl.config.schema.json) is published for editor completion.

| Key | Meaning | Default |
|---|---|---|
| `tsconfig` | The program to analyse | `tsconfig.json` |
| `services[]` | `{ name, entry, user?, tsconfig?, inboxPrefix?, extraPublish?, extraSubscribe?, denyPublish?, denySubscribe? }` | single service |
| `userTemplate`, `passwordEnvTemplate` | `${service}` / `${SERVICE}` expand to the name | `${service}`, `${SERVICE}_NATS_PASSWORD` |
| `shapes.extend[]` | Your wrappers: `{ kind, callee, receiverTypes?, subject?, stream?, durable?, mode? }` | built-in table |
| `shapes.replace[]` | Drop the built-in table | |
| `streams` | `"from-code"`, `[{ name, subjects }]`, or `{ file }` (accepts `nats stream info -j` output) | none |
| `jetstream.api` | `modern` (≥ 2.9) or `legacy` | `modern` |
| `jetstream.consumerScoping` | `auto`: scope to literal durables; `wildcard`: always `*` | `auto` |
| `jetstream.allowConsumerDelete` | `true`, `false`, or `auto` (delete calls and ephemeral consumers) | `auto` |
| `inboxPrefix` | Reply inbox prefix (`inboxPrefix` client option) | `_INBOX` |
| `widenPartialTokens` | Turn `DEVICE-${id}` into `*` instead of failing | `false` |
| `overrides[]` | `{ file, line, subject }` for call sites the evaluator cannot resolve | |
| `external.publishers` / `external.subscribers` | Subjects handled outside this program, to silence dead-subject lint | |
| `admin` | `{ user, passwordEnv? }` — an unrestricted user for provisioning | none |
| `output` | `{ format, file, account? }`; `account` wraps users in `accounts { … }` | `server`, stdout |
| `lint.deadSubjects`, `lint.overBroad` | `error` / `warning` / `off` | `warning` |
| `maxExpansions`, `maxDepth` | Bounds on enumeration and inlining | `256`, `8` |

### Declaring your own wrappers

Most codebases wrap the client. A wrapper whose subject is a parameter needs no declaration at all — the evaluator follows the parameter to every caller — as long as the wrapper's own call to the client is visible to the program. When it is not (the wrapper lives in a compiled package, or the client call is indirect), declare the shape once:

```ts
export class EventBus {
  /** @natsacl publish subject=0 */
  emit(subject: string, event: unknown): void { /* … */ }

  /** @natsacl js-subscribe subject=0 durable=1.durableName stream=1.stream mode=pull */
  consume(subject: string, opts: { durableName: string; stream: string }, handler: Handler): void { /* … */ }
}
```

or in config:

```json
{ "shapes": { "extend": [
  { "kind": "publish",      "callee": "emit",    "receiverTypes": ["EventBus"], "subject": 0 },
  { "kind": "js-subscribe", "callee": "consume", "receiverTypes": ["EventBus"], "subject": 0,
    "durable": { "arg": 1, "path": "durableName" }, "stream": { "arg": 1, "path": "stream" }, "mode": "pull" }
] } }
```

`receiverTypes` match the receiver's declared type, anything it extends, and anything it implements. A shape that matches no call is reported (`shape-unused`) so a typo cannot silently drop a whole class of grants. A declared wrapper is opaque: the client calls inside its body are what the declaration stands for and are not analysed again.

### The running service's name

Subjects like `<service>.TASKS` are built from a value that is only known at runtime — an environment variable, a config object. Tag the declaration that holds it, and the evaluator substitutes each service's name when it derives that service's grants:

```ts
export class Runtime {
  /** @natsacl service-name */
  get serviceName(): string { return process.env.SERVICE_NAME!; }
}

nc.subscribe(`${runtime.serviceName}.TASKS`);   // ingest → ingest.TASKS, alerts → alerts.TASKS
```

The tag goes on a property, getter, method, function, variable or object-literal member. `${service}` is also accepted in `overrides`, `extraPublish`, `extraSubscribe` and the deny lists.

## Output formats

| `--format` | Produces |
|---|---|
| `server` | `authorization { users: [ … ] }` for `nats-server.conf`, or `accounts { NAME { … } }` with `output.account`. Passwords are `$ENV` references. |
| `nsc` | A bash script that recreates each user with `nsc add user --allow-pub … --allow-sub …` for operator-mode deployments. |
| `jwt` | Per-user `{ pub: { allow, deny }, sub: { allow, deny }, resp }` in NATS JWT vocabulary, for pipelines that mint their own JWTs. |
| `json` | The full model: grants, provenance, per-service facts, streams and diagnostics, with paths relative to the project root. |
| `markdown` | A review document listing every grant with the code behind it. |

## CLI

```
natsacl compile [--config <file>] [--format <fmt>] [--out <file>] [--stdout] [--quiet]
natsacl check   [--config <file>] [--format <fmt>] [--out <file>]
natsacl lint    [--config <file>] [--strict]
natsacl explain <service> <subject> [--config <file>]
natsacl init    [--dir <path>]
```

Exit codes: `0` ok · `1` unresolved subjects, drift, uncovered filters, or warnings with `--strict` · `2` usage or config error. `compile` writes nothing when the model has errors.

### Diagnostics

| Code | Severity | Meaning |
|---|---|---|
| `unresolved-subject` | error | The evaluator could not pin the subject down; the message names the reason and the fix. |
| `filter-not-in-stream` | error | A consumer filter no provisioned stream carries, or a stream named in code that is not provisioned. No grant is emitted. |
| `entry-missing` | error | A service entry is not part of the program. |
| `publish-not-in-stream` | warning | A JetStream publish no stream captures; it would time out with no responders. |
| `no-subscriber` / `no-publisher` | warning | Dead subjects. Declare `external.*` for subjects handled by other systems. |
| `consumer-wide-grant` | warning | The durable name is not a literal, so consumer grants use `*`. |
| `stream-unknown` | warning | No stream named in code and none configured; the stream token is `*`. |
| `stream-admin-in-service` | warning | A service creates or deletes streams; it receives no stream grants. |
| `over-broad` | warning | A grant with a wildcard in the first token. |
| `widened` | warning | A partial token was widened under `widenPartialTokens`. |
| `shape-unused` | warning | A declared shape matched nothing. |
| `override-used` | info | A subject came from an override rather than the code. |

## CI

```yaml
- run: npx natsacl check        # permissions file matches the code
- run: npx natsacl lint --strict
```

Pair it with the stream provisioning you already have: point `streams` at `nats stream info -j` output captured from the environment, or at the code that calls `jsm.streams.add`, and the coverage check runs against the same definitions the server will.

## Limits, stated plainly

- **Only what the program can see.** Calls made by compiled dependencies, or by code outside the `tsconfig`, are invisible; declare them with a shape or an override. Dependency-injected wrappers whose subject arrives from outside the program need a declaration too — the `no-callers` error says so.
- **A dynamic token is `*`, not `>`.** `` `LOGS.${path}` `` where `path` contains dots is under-granted; a runtime permission error will tell you, and an override fixes it. The compiler never widens silently.
- **Consumer names cannot be scoped per user** when they are not literals: JetStream API subjects carry the consumer name as one token, so `INFO`/`NEXT`/`ACK` fall back to `*` for that stream.
- **A permission pattern containing `*` also admits the literal token `*`**, so `$JS.API.CONSUMER.CREATE.S.D.SENSORS.*` allows creating a consumer with filter `SENSORS.anything` as well as `SENSORS.*`. This is inherent to NATS permissions.
- **KV and Object Store** buckets (`$KV.>`, `$O.>`) are not yet derived; add them with `extraPublish`/`extraSubscribe`.
- **Operator mode** output is an `nsc` script and JWT JSON; `natsacl` does not mint or push JWTs.

## Contributing

```sh
npm ci
npm run check      # typecheck, tests, build
```

Tests run the compiler over fixture projects in `test/fixtures` and assert on the resulting grants, so a change to the evaluator shows up as a concrete permission difference. Add a fixture for any new resolution rule.

## License

MIT
