import type { NatsConnection } from 'nats';

const ROUTES: Record<string, string> = { thermal: 'thermal-svc', optical: 'optical-svc' };
type Route = string;
import { CONTRACTS, EventPublisher, FirmwareUpdated, SENSOR_CALIBRATED_PREFIX, SUBJECTS, sensorStatusSubject } from '../shared/index.js';

export class ReadingService {
  private readonly publisher: EventPublisher;
  constructor(private readonly nc: NatsConnection) {
    this.publisher = new EventPublisher(nc);
  }

  record(id: string, priority: boolean): void {
    this.publisher.publishEvent(SUBJECTS.SENSOR_READING, { id });
    this.publisher.publishRaw(priority ? 'SENSORS.priority' : 'SENSORS.routine', new Uint8Array());
    this.nc.publish(`${SENSOR_CALIBRATED_PREFIX}.${id}`, '');
    this.nc.publish(sensorStatusSubject(id), '');
    this.nc.publish(['SENSORS', 'heartbeat', id].join('.'), '');
    this.nc.publish(FirmwareUpdated.subject, '');
    this.nc.publish(CONTRACTS.alertRaised.subject, '');
    this.nc.publish(`SENSORS.${id.toUpperCase()}.trimmed`, '');
  }

  dispatch(route: Route): void {
    const target = ROUTES[route]!.replace(/-svc$/, '').toUpperCase();
    this.nc.publish(`${target}.TASKS`, '');
  }

  async lookup(sensorId: string): Promise<void> {
    await this.nc.request('CATALOG.LOOKUP', sensorId, { timeout: 1000 });
  }

  legacy(): void {
    // natsacl-subject: SENSORS.legacy.>
    this.nc.publish(buildLegacy(), '');
  }
}

declare function buildLegacy(): string;
