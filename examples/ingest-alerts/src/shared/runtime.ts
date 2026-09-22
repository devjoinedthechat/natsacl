/** Which service this process runs as; resolved from the environment at boot. */
export class Runtime {
  /** @natsacl service-name */
  get serviceName(): string {
    return process.env.SERVICE_NAME ?? 'unknown';
  }
}
