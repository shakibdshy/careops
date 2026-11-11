import { Controller, Get } from '@nestjs/common';
import type { HealthResponse } from '@careops/shared';
import { HealthService } from './health.service.js';

@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get()
  async check(): Promise<HealthResponse> {
    return this.healthService.check();
  }
}
