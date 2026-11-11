import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { OrgScopedRepository } from '../data/org-scoped.repository.js';
import { PatientDocument, type PatientDoc } from './patient.schema.js';

@Injectable()
export class PatientRepository extends OrgScopedRepository<PatientDoc> {
  constructor(
    @InjectModel(PatientDocument.name)
    patientModel: Model<PatientDoc>,
  ) {
    super(patientModel);
  }
}
