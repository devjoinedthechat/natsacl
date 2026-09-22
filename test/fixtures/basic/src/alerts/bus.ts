import type { NatsConnection } from 'nats';

/** A wrapper that is a JetStream subscription when a durable is named, and a core subscription otherwise. */
export class Bus {
  constructor(private readonly nc: NatsConnection) {}

  /** @natsacl js-subscribe subject=0 durable=2.durableName stream=2.stream whenNoDurable=subscribe */
  on(subject: string, handler: (data: unknown) => void, options?: { durableName?: string; stream?: string }): void {
    void handler;
    void options;
    void this.nc;
  }
}

export class Wiring {
  constructor(private readonly bus: Bus) {}

  start(): void {
    this.bus.on('ALERTS.muted', () => undefined); // core: no durable named
    this.bus.on('ALERTS.reopened', () => undefined, { durableName: 'alerts-reopened', stream: 'TELEMETRY' });
  }
}
