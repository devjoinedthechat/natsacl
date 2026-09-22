import type { NatsConnection } from 'nats';

type Publisher = Pick<NatsConnection, 'publish'>;

export class Notifier {
  constructor(private readonly nc: Publisher) {}

  notify(): void {
    this.nc.publish('SENSORS.notified', '');
  }
}
