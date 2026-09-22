import type { JetStreamClient } from 'nats';

export async function buckets(js: JetStreamClient, name: string): Promise<void> {
  await js.views.kv('sessions');
  await js.views.kv(name, { bindOnly: true });
}
