export const SUBJECTS = {
  SENSOR_READING: 'SENSORS.reading',
  SENSOR_DECOMMISSIONED: 'SENSORS.decommissioned',
  ALERT_RAISED: 'ALERTS.raised',
} as const;

export enum LegacySubjects {
  AlertCleared = 'ALERTS.cleared',
}

export type IncidentKind = 'opened' | 'closed';

const PREFIX = 'SENSORS';
export const SENSOR_CALIBRATED_PREFIX = `${PREFIX}.calibrated`;

export function sensorStatusSubject(sensorId: string): string {
  return `${PREFIX}.${sensorId}.status`;
}
