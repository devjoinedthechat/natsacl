import type { NatsConnection } from 'nats';

export interface Publisher {
  publishEvent(subject: string, payload: unknown): void;
}

/** A wrapper: the subject is a parameter, so the analyser follows every caller. */
export class EventPublisher implements Publisher {
  constructor(private readonly nc: NatsConnection) {}

  publishEvent(subject: string, payload: unknown): void {
    this.nc.publish(subject, JSON.stringify(payload));
  }

  /** @natsacl publish subject=0 */
  publishRaw(subject: string, bytes: Uint8Array): void {
    void bytes;
    void subject;
    // implementation lives in a compiled dependency; the tag declares the shape
  }
}
