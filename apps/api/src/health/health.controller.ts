import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { HealthResponse } from '@careops/shared';
import { HealthService } from './health.service.js';

@ApiTags('Health')
@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get()
  @ApiOperation({
    summary: 'Liveness with dependency status',
    description:
      'Reports ok/degraded plus per-store connectivity (Mongo, Redis). Unauthenticated by design.',
  })
  @ApiOkResponse({ description: 'Store connectivity report' })
  async check(): Promise<HealthResponse> {
    return this.healthService.check();
  }
}
