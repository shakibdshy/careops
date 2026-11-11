import type { Job } from 'bullmq';
import { NotificationProcessor } from './notification.processor.js';
import {
  PATIENT_CREATED_JOB,
  patientCreatedJobId,
  type PatientCreatedJob,
} from './notifications.tokens.js';

describe('NotificationProcessor', () => {
  it('processes a patient.created job with a stubbed delivery', async () => {
    const processor = new NotificationProcessor({ name: 'notifications' } as never);
    const result = processor.process({
      id: patientCreatedJobId('p1'),
      name: PATIENT_CREATED_JOB,
      data: { organizationId: 'org-1', patientId: 'p1', patientName: 'Ada Lovelace' },
    } as unknown as Job<PatientCreatedJob>);
    expect(result).toEqual({ delivered: true, to: 'org-org-1@notifications.stub' });
  });
});
