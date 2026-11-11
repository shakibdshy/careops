# CareOps

Back-office operations for care organizations: an organization's staff manage patient
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
