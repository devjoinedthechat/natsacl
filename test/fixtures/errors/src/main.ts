import type { NatsConnection } from 'nats';

export class Broken {
  constructor(private readonly nc: NatsConnection) {}

  partial(id: string): void {
    this.nc.publish(`DEVICE-${id}`, '');
  }

  noCallers(subject: string): void {
    this.nc.publish(subject, '');
  }

  opaque(): void {
    this.nc.publish(process.env.SUBJECT!, '');
  }

  fine(): void {
    this.nc.publish('HEALTH.ok', '');
  }
}
