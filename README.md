<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
    <img src="assets/logo.svg" width="400" alt="natsacl">
  </picture>
</p>

<p align="center">
  <b>Least-privilege NATS permissions, compiled from your TypeScript.</b><br>
  One broker user per service, with exactly the subjects its code touches — and a CI gate that fails when the two drift apart.
</p>

<p align="center">
  <a href="https://github.com/devjoinedthechat/natsacl/actions/workflows/ci.yml"><img src="https://github.com/devjoinedthechat/natsacl/actions/workflows/ci.yml/badge.svg" alt="ci"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-0f766e" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A5%2020-0f766e" alt="node >= 20">
  <img src="https://img.shields.io/badge/typescript-%E2%89%A5%205-0f766e" alt="typescript >= 5">
  <img src="https://img.shields.io/badge/runtime%20deps-none-0f766e" alt="no runtime dependencies">
</p>

---

**Contents** · [Why](#why) · [Highlights](#highlights) · [Install](#install) · [Quick start](#quick-start) · [How it works](#how-it-works) · [What a consumer needs](#what-a-consumer-needs) · [Configuration](#configuration) · [Your own wrappers](#declaring-your-own-wrappers) · [Policy](#policy) · [Output formats](#output-formats) · [CLI](#cli) · [Diagnostics](#diagnostics) · [CI](#ci) · [Validation](#validation-on-a-real-codebase) · [Comparison](#comparison) · [Limits](#limits-stated-plainly) · [Contributing](#contributing)

## Why

A shared NATS credential lets any pod publish any subject. One compromised or merely buggy service can forge another service's events, drain a command bus, or delete a stream. NATS has fine-grained permissions to prevent that — but they are hand-written, so they drift from the code within weeks, and the first symptom of drift is a permissions violation on a live message.

No existing tooling derives those permissions from the code. `nsc`, the Terraform provider and the control planes manage credentials a human authors; IAM policy generators observe traffic instead of reading source. `natsacl` closes that gap for TypeScript: the permissions file becomes a build artifact, and the difference between it and the code becomes a CI failure.

It closes a second, subtler gap. JetStream does not enforce subscribe permissions on consumer filters ([nats-server#3202](https://github.com/nats-io/nats-server/issues/3202)); the only boundary is the consumer-creation API subject, which embeds the filter. `natsacl` scopes every `$JS.API.CONSUMER.CREATE` grant to the exact filter the code subscribes with, and checks that filter against the streams you provision — because a filter outside a stream's subjects is rejected at consumer creation, usually inside a caught handler, leaving a healthy-looking service with a dead subscriber.

## Highlights

- **Real program analysis.** Loads your project with the TypeScript type checker, so barrels, aliases, overloads, interfaces and class hierarchies resolve the way `tsc` resolves them.
- **Follows the subject wherever it goes.** Constants across modules, enums, `as const` objects, templates, `join`, ternaries, string-literal union types, functions that return subjects, factory-built objects, records indexed by a dynamic key, and pure string transforms over a finite set.
- **Wrappers need no configuration.** A parameter that carries a subject is evaluated at every call site of the wrapper, including calls through the interfaces and base classes it implements. An abstract `subject` property is evaluated at every subclass that initialises it.
- **Per-service attribution by reachability.** A fact belongs to a service when the file performing the call, and every file its value travelled through, is reachable from that service's entry. A shared base class is granted only to the services whose subclasses use it.
- **Never over-grants.** A dynamic token becomes `*`, never `>`. A dynamic fragment inside a token is an error with the fix named. A subject with no literal part is refused.
- **JetStream done properly.** Consumer grants scoped to the filter and, when the code names it, the durable; stream inference from provisioned streams; a stream named in code is verified to exist and to carry the filter; KV buckets get exactly the grants the client's put, get, watch and keys need.
- **Five outputs.** `nats-server` config, `nsc` script, JWT permission JSON, a JSON model with provenance, a Markdown review.
- **Policy at build time.** `policy.forbid` fails `compile` with the call sites when the code implies a grant a service must never hold, instead of denying it silently at runtime.
- **Every grant is explainable.** `natsacl explain <user> <subject>` prints the call sites and the chain of declarations behind it.
- **Verified against a real broker.** The test suite loads the generated permissions into `nats-server` and proves the allows and the denies with the official client.
- **Zero runtime dependencies** beyond your own `typescript`.

## Install

```sh
npm install --save-dev natsacl typescript
```

Node 20 or later. TypeScript 5 or later is a peer dependency; the analysis runs on your project's own `tsconfig.json`.

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

```
 tsconfig.json ──▶ ts.Program ──▶ match calls ──▶ evaluate subjects ──▶ attribute ──▶ derive grants ──▶ render
                   (checker)      (shape table)    (finite patterns)    (reachability)  (+ stream check)   (+ check/lint)
```

1. **Parse.** The project is loaded as a real TypeScript program with the type checker.
2. **Match.** Every call is matched against a table of *shapes* — which method on which receiver type is a publish, a request, a subscribe, a JetStream consumer creation, and which argument carries the subject, stream and durable name. The built-in table covers the official `nats` and `@nats-io/*` clients; your own wrappers are declared in config or with a `@natsacl` JSDoc tag. The receiver is matched by its declared type, everything it extends or implements, and the class or interface that declares the called member — so a `Pick<NatsConnection, 'publish'>` still matches.
3. **Evaluate.** The subject argument is evaluated to a finite set of NATS patterns:
   - string literals, `as const` objects, enums, constants across modules;
   - template literals, `+`, `[…].join('.')`, ternaries, `??` and `||`;
   - string-literal union types and template-literal types on parameters and properties;
   - records indexed by a dynamic key (every member), and pure string transforms over a finite set (`toLowerCase`, `replace` with literal arguments);
   - functions that return subjects, inlined with their arguments bound;
   - **wrapper parameters**, evaluated at every call site of the wrapper — including calls through the interfaces and base classes it implements;
   - **abstract or uninitialised properties**, evaluated at every subclass that initialises them, so a base class calling `this.nats.subscribe(this.subject)` yields one fact per concrete subscriber, each paired with that subscriber's own durable name.
4. **Attribute.** A fact belongs to a service when the file performing the call, and every product file its value travelled through, is reachable through imports from that service's entry.
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

## What a consumer needs

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
| stream named in code | verified to exist and to carry the filter; otherwise an error and no grant | |
| durable not a literal | `*` for the consumer token, reported as `consumer-wide-grant` | |
| unnamed (ephemeral / ordered) consumer | `*` for the consumer token, plus `CONSUMER.DELETE` | |
| `js.views.kv('cfg', { bindOnly: true })` / `kvm.open('cfg')` | `$KV.cfg.>`, `$JS.API.STREAM.INFO.KV_cfg`, `$JS.API.DIRECT.GET.KV_cfg.>`, `$JS.API.STREAM.MSG.GET.KV_cfg`, and `CONSUMER.CREATE/INFO/MSG.NEXT/DELETE` on `KV_cfg` for watches (server-named ordered consumers) | `_INBOX.>` |
| `js.views.kv('cfg')` without `bindOnly` / `kvm.create('cfg')` | as above, plus a `kv-create-in-service` warning: creating the bucket is stream administration | |
| `jsm.streams.info('S')`, `streams.list()`, `streams.names()`, `getAccountInfo()` | `$JS.API.STREAM.INFO.S`, or `$JS.API.STREAM.LIST` and `$JS.API.STREAM.NAMES`; `$JS.API.INFO` | `_INBOX.>` |
| `jsm.streams.add(…)` inside a service | **nothing** — reported as `stream-admin-in-service`; streams are provisioned by the `admin` user | |

Set `jetstream.api: "legacy"` to also grant `$JS.API.CONSUMER.DURABLE.CREATE` for servers before 2.9.

## Configuration

`natsacl.config.json` (or `.js` / `.mjs` exporting `defineConfig({...})`). A [JSON schema](./schema/natsacl.config.schema.json) is published for editor completion.

| Key | Meaning | Default |
|---|---|---|
| `tsconfig` | The program to analyse; a solution-style root with `references` loads every referenced project | `tsconfig.json` |
| `services[]` | `{ name, entry, user?, passwordEnv?, nkey?, tsconfig?, inboxPrefix?, extraPublish?, extraSubscribe?, denyPublish?, denySubscribe? }`; an `nkey` user is rendered without a password | single service |
| `userTemplate`, `passwordEnvTemplate` | `${service}` / `${SERVICE}` expand to the name | `${service}`, `${SERVICE}_NATS_PASSWORD` |
| `shapes.extend[]` | Your wrappers: `{ kind, callee, receiverTypes?, subject?, stream?, durable?, mode?, whenNoDurable? }` | built-in table |
| `shapes.replace[]` | Drop the built-in table | |
| `streams` | `"from-code"`, `[{ name, subjects }]`, or `{ file }` (accepts `nats stream info -j` output) | none |
| `jetstream.api` | `modern` (≥ 2.9) or `legacy` | `modern` |
| `jetstream.consumerScoping` | `auto`: scope to literal durables; `wildcard`: always `*` | `auto` |
| `jetstream.allowConsumerDelete` | `true`, `false`, or `auto` (delete calls and ephemeral consumers) | `auto` |
| `inboxPrefix` | Reply inbox prefix; `${service}` expands per service (set the client's `inboxPrefix` option to match) | `_INBOX` |
| `widenPartialTokens` | Turn `DEVICE-${id}` into `*` instead of failing | `false` |
| `overrides[]` | `{ file, line, subject }` for call sites the evaluator cannot resolve | |
| `external.publishers` / `external.subscribers` | Subjects handled outside this program, to silence dead-subject lint | |
| `admin` | `{ user, passwordEnv? }` — an unrestricted user for provisioning | none |
| `output` | `{ format, file, account? }`; `account` wraps users in `accounts { … }` | `server`, stdout |
| `lint.deadSubjects`, `lint.overBroad` | `error` / `warning` / `off` | `warning` |
| `policy.forbid[]` | `{ subject, publish?, subscribe?, except?, reason? }` — grants the code must never imply; see [Policy](#policy) | |
| `maxExpansions`, `maxDepth` | Bounds on enumeration and inlining | `256`, `8` |

## Declaring your own wrappers

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

A wrapper that is a JetStream subscription when a durable is named and a core subscription otherwise declares that too, so its core subscriptions do not receive JetStream API grants:

```ts
/** @natsacl js-subscribe subject=0 durable=2.durableName stream=2.stream whenNoDurable=subscribe */
on(subject: string, handler: Handler, options?: { durableName?: string; stream?: string }): void { /* … */ }
```

`receiverTypes` match the receiver's declared type, anything it extends, anything it implements, and the owner of the called member. A shape that matches no call is reported (`shape-unused`) so a typo cannot silently drop a whole class of grants. A declared wrapper is opaque: the client calls inside its body are what the declaration stands for and are not analysed again.

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

## Policy

The compiler makes the permissions follow the code. Policy decides what the code may not do, and fails the build when it does:

```jsonc
{
  "policy": {
    "forbid": [
      { "subject": "KEYS.>",     "except": ["vault"],  "reason": "key material leaves only through vault" },
      { "subject": "AUDIT.>",    "publish": false,     "reason": "audit is read by the archiver only", "except": ["archiver"] },
      { "subject": "*.TASKS",    "subscribe": true, "publish": false, "except": ["worker"] }
    ]
  }
}
```

A rule is checked against what each service's code does — publishing (`publish`, `request`, JetStream publish) and consuming (`subscribe`, JetStream consumers, service endpoints) — not against the rendered file, so a JetStream consumer on a forbidden filter is caught even though it appears in the permissions as a `$JS.API.CONSUMER.CREATE…` grant. `extraPublish` and `extraSubscribe` entries are checked too. A violation is an error with the call site; `compile` writes nothing.

Policy complements deny lists rather than replacing them: a deny list is enforced by the server at runtime, a policy rule stops the change from being merged.

### Isolating reply inboxes

Every user needs to subscribe to its reply inbox, and by default that is `_INBOX.>` — the same prefix for everyone in the account, so any user can read any other user's replies. To isolate them, give each service its own prefix and tell the client:

```jsonc
{ "inboxPrefix": "_INBOX_${service}" }
```

```ts
const nc = await connect({ servers, inboxPrefix: `_INBOX_${process.env.SERVICE_NAME}` });
```

`natsacl` reports `shared-inbox` once per compile while the prefix is shared. It does not change the default, because the permissions file and the client have to agree.

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

## Diagnostics

| Code | Severity | Meaning |
|---|---|---|
| `unresolved-subject` | error | The evaluator could not pin the subject down; the message names the reason and the fix. |
| `policy-violation` | error | The code implies a grant that `policy.forbid` rules out for this service. No file is written. |
| `filter-not-in-stream` | error | A consumer filter no provisioned stream carries, or a stream named in code that is not provisioned. No grant is emitted. |
| `entry-missing` | error | A service entry is not part of the program. |
| `publish-not-in-stream` | warning | A JetStream publish no stream captures; it would time out with no responders. |
| `no-subscriber` / `no-publisher` | warning | Dead subjects. Declare `external.*` for subjects handled by other systems. |
| `consumer-wide-grant` | warning | The durable name is not a literal, so consumer grants use `*`. |
| `stream-unknown` | warning | No stream named in code and none configured; the stream token is `*`. |
| `stream-admin-in-service` | warning | A service creates or deletes streams; it receives no stream grants. |
| `kv-create-in-service` | warning | A KV bucket is opened without `bindOnly`, so the client would create it; provision it from the admin user instead. |
| `over-broad` | warning | A grant with a wildcard in the first token. |
| `shared-inbox` | info | Every user subscribes to the same reply inbox prefix; set `inboxPrefix` to `_INBOX_${service}` to isolate replies. |
| `widened` | warning | A partial token was widened under `widenPartialTokens`. |
| `shape-unused` | warning | A declared shape matched nothing. |
| `override-used` | info | A subject came from an override rather than the code. |

## CI

```yaml
- run: npx natsacl check        # permissions file matches the code
- run: npx natsacl lint --strict
```

Under GitHub Actions every diagnostic is also emitted as a workflow command, so unresolved subjects, policy violations and uncovered filters appear as annotations on the pull request diff at the call site. Pass `--annotations` to get them elsewhere, or `--no-annotations` to suppress them.

Pair it with the stream provisioning you already have: point `streams` at `nats stream info -j` output captured from the environment, or at the code that calls `jsm.streams.add`, and the coverage check runs against the same definitions the server will.

## Validation on a real codebase

Before release the compiler was run over a 14-service TypeScript monorepo (a shared library of about 1,800 files plus the services; roughly 1,300 files reachable per service) that already maintained a hand-written per-service NATS permissions file. The whole backend compiles in about eleven seconds.

- Consumer-creation grants agreed with the hand-maintained file on 392 of 402 entries. The remaining ten came from a wrapper type the validation config had not declared and one service that never imports the command router, both of which `explain` makes visible.
- For one service, 37 of its 49 consumer grants were scoped to the literal durable name the code uses; the hand-maintained file used `*` for every one.
- Eight literal subjects replaced one `PREFIX.>` wildcard where a union type enumerated the exact set the code could publish.
- Every subject the compiler could not resolve was reported with its call site; there were none left after three `${service}` overrides for a command bus built from the runtime service name.

## Comparison

| | Hand-written `nats-server.conf` / `nsc` | Control planes and Terraform | IAM policy generators (traffic-based) | **natsacl** |
|---|---|---|---|---|
| Source of truth | a person | a person | observed traffic | the code |
| Drift detection | none | none | not applicable | `check` in CI |
| JetStream filter scoping | by hand | by hand | not applicable | from the filter the code uses |
| Stream coverage check | none | none | not applicable | every filter against provisioned streams |
| Justification per grant | none | none | request log | `explain`: call sites and declaration chain |
| Broker | NATS | NATS | cloud IAM | NATS (subject-based brokers are the natural next step) |

## Limits, stated plainly

- **Only what the program can see.** Calls made by compiled dependencies, or by code outside the `tsconfig`, are invisible; declare them with a shape or an override. Dependency-injected wrappers whose subject arrives from outside the program need a declaration too — the `no-callers` error says so.
- **A dynamic token is `*`, not `>`.** `` `LOGS.${path}` `` where `path` contains dots is under-granted; a runtime permission error will tell you, and an override fixes it. The compiler never widens silently.
- **Consumer names cannot be scoped per user** when they are not literals: JetStream API subjects carry the consumer name as one token, so `INFO`/`NEXT`/`ACK` fall back to `*` for that stream.
- **A permission pattern containing `*` also admits the literal token `*`**, so `$JS.API.CONSUMER.CREATE.S.D.SENSORS.*` allows creating a consumer with filter `SENSORS.anything` as well as `SENSORS.*`. This is inherent to NATS permissions.
- **Object Store** buckets (`$O.>`) are not derived; add them with `extraPublish`/`extraSubscribe`. KV buckets are, from literal bucket names only.
- **Operator mode** output is an `nsc` script and JWT JSON; `natsacl` does not mint or push JWTs.

## Contributing

```sh
npm ci
npm run check      # typecheck, tests, build
```

Tests run the compiler over fixture projects in `test/fixtures` and assert on the resulting grants, so a change to the evaluator shows up as a concrete permission difference. Add a fixture for any new resolution rule.

When Docker is available, `npm test` also starts a real `nats-server` (`nats:2.10-alpine`) with the generated permissions and drives it with the official client: the fixture's users create their filtered consumers, publish, consume and ack, and are refused every operation their code does not perform. That test is what pins the JetStream API grant table to server and client behaviour rather than to documentation; it is skipped when Docker is absent.

## License

[MIT](./LICENSE)
