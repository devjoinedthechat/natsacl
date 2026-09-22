import { CatalogResponder } from './catalog.responder.js';
import { ThresholdSubscriber } from './threshold.subscriber.js';
import { IncidentWriter } from './incidents.js';
import { TaskBus } from './tasks.js';
import { AckSubscriber, EscalationSubscriber } from './two-in-one.js';
import { DigestSubscriber } from './digest.subscriber.js';
import { Settings } from './settings.js';
import { Bus, Wiring } from './bus.js';

export const wiring = [CatalogResponder, ThresholdSubscriber, IncidentWriter, TaskBus, AckSubscriber, EscalationSubscriber, DigestSubscriber, Settings, Bus, Wiring];
