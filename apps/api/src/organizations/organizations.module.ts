import { Module } from '@nestjs/common';
import { OrganizationsController } from './organizations.controller.js';

@Module({
  controllers: [OrganizationsController],
})
export class OrganizationsModule {}
