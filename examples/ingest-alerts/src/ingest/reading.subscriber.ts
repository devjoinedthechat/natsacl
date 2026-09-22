import { BaseSubscriber, SUBJECTS } from '../shared/index.js';

export class ReadingSubscriber extends BaseSubscriber {
  protected readonly subject = SUBJECTS.SENSOR_READING;
  protected readonly durable = 'ingest-sensor-readings';
}
