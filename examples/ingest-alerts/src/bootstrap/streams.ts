import type { JetStreamManager } from 'nats';

export async function provision(jsm: JetStreamManager): Promise<void> {
  await jsm.streams.add({ name: 'TELEMETRY', subjects: ['SENSORS.>', 'ALERTS.>', 'INCIDENTS.>'] });
}
