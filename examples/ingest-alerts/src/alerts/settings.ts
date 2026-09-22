import type { JetStreamClient } from 'nats';

/** Configuration lives in a KV bucket the admin provisions; the service only binds to it. */
export class Settings {
  constructor(private readonly js: JetStreamClient) {}

  async threshold(): Promise<string | null> {
    const kv = await this.js.views.kv('cfg', { bindOnly: true });
    const entry = await kv.get('threshold');
    return entry?.string() ?? null;
  }
}
