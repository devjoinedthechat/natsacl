import { BaseSubscriber, LegacySubjects, SUBJECTS } from '../shared/index.js';

export class ThresholdSubscriber extends BaseSubscriber {
  protected readonly subject = process.env.LEGACY ? LegacySubjects.AlertCleared : SUBJECTS.ALERT_RAISED;
  protected readonly durable = 'alerts-thresholds';
}
