import { BaseSubscriber } from '../shared/index.js';

declare function durableFromRegistry(key: string): string;

export class AckSubscriber extends BaseSubscriber {
  protected readonly subject = 'ALERTS.acknowledged';
  protected readonly durable = 'alerts-acks';
}

/** Its durable is opaque to the analyser; only this subscriber's consumer grants fall back to "*". */
export class EscalationSubscriber extends BaseSubscriber {
  protected readonly subject = 'ALERTS.escalated';
  protected readonly durable = durableFromRegistry('escalation');
}
