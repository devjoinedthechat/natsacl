import type { NatsConnection } from 'nats';

export class CatalogResponder {
  constructor(private readonly nc: NatsConnection) {}

  async run(): Promise<void> {
    for await (const msg of this.nc.subscribe('CATALOG.LOOKUP')) {
      msg.respond('{"model":"TH-200"}');
    }
  }
}
