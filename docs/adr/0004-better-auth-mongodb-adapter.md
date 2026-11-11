# BetterAuth with the official MongoDB adapter

Authentication uses BetterAuth (email + password) mounted in NestJS, backed by BetterAuth's
official MongoDB adapter, which uses the native driver. Auth is the most security-sensitive
component in the system, so the officially supported adapter path was chosen over community
glue (better-auth-mongoose) or a hand-rolled adapter, even though the rest of the domain
uses Mongoose — accepting two MongoDB client stacks in the API is cheaper than
self-maintaining auth persistence. Multi-tenancy (organizations, invitations, member
roles) comes from BetterAuth's organization plugin rather than custom tables.

## Consequences

- Auth collections (user, session, account, verification, organization, member,
  invitation) are owned by BetterAuth's adapter and never modeled in Mongoose.
- Domain code reads org/user context from the verified session, never from the request
  body.
