import type { JetStreamClient, JetStreamManager } from 'nats';
import type { IncidentKind } from '../shared/index.js';

export class IncidentWriter {
  constructor(
    private readonly js: JetStreamClient,
    private readonly jsm: JetStreamManager,
  ) {}

  async setup(): Promise<void> {
    await this.jsm.consumers.add('TELEMETRY', { durable_name: 'alerts-incidents', filter_subject: 'INCIDENTS.>' });
    const consumer = await this.js.consumers.get('TELEMETRY', 'alerts-incidents');
    void consumer;
    void (await this.jsm.streams.list().next());
  }

  async write(kind: IncidentKind): Promise<void> {
    await this.js.publish(`INCIDENTS.${kind}`, '');
  }
}
