import { ReadingService } from './reading.service.js';
import { ReadingSubscriber } from './reading.subscriber.js';
import { Notifier } from './pick-receiver.js';

export const wiring = [ReadingService, ReadingSubscriber, Notifier];
