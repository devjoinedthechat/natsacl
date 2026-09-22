import { BaseSubscriber } from '../shared/index.js';
import { Runtime } from '../shared/runtime.js';

/** Its durable is built from the running service's name: `${service}-digest` resolves per service. */
export class DigestSubscriber extends BaseSubscriber {
  private readonly runtime = new Runtime();
  protected readonly subject = 'ALERTS.digest';
  protected readonly durable = `${this.runtime.serviceName}-digest`;
}
