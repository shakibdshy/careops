import { Injectable } from '@nestjs/common';
import type { HealthResponse } from '@careops/shared';

@Injectable()
export class HealthService {
  check(): HealthResponse {
    return { status: 'ok', service: 'careops-api' };
  }
}
