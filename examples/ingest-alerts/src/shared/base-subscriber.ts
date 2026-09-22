import type { JetStreamClient } from 'nats';

/** Each subclass names its subject and durable; the base performs the subscription. */
export abstract class BaseSubscriber {
  protected abstract readonly subject: string;
  protected abstract readonly durable: string;

  constructor(protected readonly js: JetStreamClient) {}

  async start(): Promise<void> {
    await this.js.pullSubscribe(this.subject, { config: { durable_name: this.durable }, stream: 'TELEMETRY' });
  }
}
