import type { NatsConnection } from 'nats';

export function ping(nc: NatsConnection): void {
  nc.publish('REF.ok', '');
}
