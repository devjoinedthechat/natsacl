export interface WireContract {
  readonly subject: string;
  readonly version: number;
}

export function defineContract(def: { subject: string; version: number }): WireContract {
  return { subject: def.subject, version: def.version };
}

export const FirmwareUpdated = defineContract({ subject: 'SENSORS.firmware', version: 1 });

export const CONTRACTS = {
  firmwareUpdated: FirmwareUpdated,
  alertRaised: defineContract({ subject: 'ALERTS.raised', version: 2 }),
} as const;
