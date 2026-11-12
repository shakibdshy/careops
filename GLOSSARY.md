# CareOps

Back-office operations for care organizations: an organization's Members manage Patient
records and coordinate care work. CareOps is multi-tenant — one deployment serves many
independent organizations whose data never crosses boundaries.

## Language

**Organization**:
A care provider that subscribes to CareOps; the tenant boundary. All care data belongs
to exactly one Organization.
_Avoid_: Tenant, Clinic, Company, Account

**User**:
A person authenticated to use CareOps (email + password). Users operate on Patient
records. Patients never log in.
_Avoid_: Staff, Account, Employee

**Member**:
A User's role-bearing membership in an Organization — owner, admin, or member. A User
can belong to more than one Organization; permissions attach to the Member, not the User.
_Avoid_: Staff, Role, Employee

**Patient**:
An Organization-scoped record of a person receiving care — an operational record, not a
medical chart. Two Organizations may hold records for the same real person; those are
two Patients.
_Avoid_: Client, Resident

**Audit Entry**:
An immutable who/what/when/before→after record of a mutation to care data. Audit
Entries are append-only and never edited or deleted.
_Avoid_: History, Activity, Log line

**Appointment**:
A scheduled block of a Provider's time for one Patient, with a start time and a
duration. It moves through a clinic lifecycle — scheduled, confirmed, checked in, in
progress, completed — or ends cancelled or as a No-Show.
_Avoid_: Booking, Visit, Session

**Provider**:
The Member assigned to deliver a specific Appointment. Not a separate kind of User —
every Provider is a Member of the Organization.
_Avoid_: Staff, Caregiver, Clinician

**Check-In**:
The recording that a Patient has arrived for an Appointment.
_Avoid_: Arrival, Admission

**No-Show**:
A terminal Appointment outcome recorded by staff when the Patient fails to arrive;
never inferred automatically.
_Avoid_: Absence, Missed appointment

**Reschedule**:
Changing an upcoming Appointment's start time, duration, or Provider; subject to the
same conflict rules as a new Appointment.
_Avoid_: Move, Rebook

**Conflict**:
An overlap in time between two Appointments of the same Provider. New and rescheduled
Appointments that would create one are rejected, not warned about.
_Avoid_: Double-booking, Collision

**Contact Email**:
An optional email address on a Patient used to deliver notifications; the Patient
never authenticates with it.
_Avoid_: Email, Username
