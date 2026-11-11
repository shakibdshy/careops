import { Global, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuditEntryDocument, AuditEntryModelSchema } from './audit-entry.schema.js';
import { AuditService } from './audit.service.js';

@Global()
@Module({
  imports: [
    MongooseModule.forFeature([{ name: AuditEntryDocument.name, schema: AuditEntryModelSchema }]),
  ],
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
