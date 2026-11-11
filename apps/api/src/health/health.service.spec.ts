import { HealthService } from './health.service.js';

describe('HealthService', () => {
  it('reports ok status for the api service', () => {
    const service = new HealthService();
    expect(service.check()).toEqual({ status: 'ok', service: 'careops-api' });
  });
});
