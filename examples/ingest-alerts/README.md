# ingest-alerts

Two services — `ingest` and `alerts` — sharing a library with a base subscriber class, a wrapper whose subject is a parameter, a `@natsacl`-tagged method, an inline override, a factory-built contract and a `@natsacl service-name` getter.

```sh
npm install
npx natsacl compile          # writes nats/auth.conf
npx natsacl check            # exit 1 if nats/auth.conf drifts from the code
npx natsacl explain alerts-svc INCIDENTS.opened
```

`nats/auth.conf` is checked in; the repository's CI runs `natsacl check` against it.
