# Zod-first shared contract

The API and web app must agree on request/response shapes in both directions with no
drift. The single source of truth is a Zod schema in the shared package: the API uses
it for request validation (via nestjs-zod) and for OpenAPI/Swagger generation, and the
web app imports the inferred TypeScript types. Because the docs and the validation
come from the same schema, Swagger can never lie about what the API accepts.

## Considered Options

- **OpenAPI codegen client** — types flow one direction only, adds a codegen step to
  every build, and client-side validation would duplicate the schema.
- **tRPC** — excellent inference, but fights NestJS's REST-first design and abandons
  the OpenAPI requirement.

## Consequences

Adding a feature means writing the schema first; both apps then update in lockstep and
TypeScript breaks if either side drifts.
