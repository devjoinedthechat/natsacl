import type { NatsConnection } from 'nats';
import { Runtime } from '../shared/runtime.js';

export class TaskBus {
  private readonly runtime = new Runtime();
  constructor(private readonly nc: NatsConnection) {}

  listen(): void {
    this.nc.subscribe(`${this.runtime.serviceName}.TASKS`);
  }
}
