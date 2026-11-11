# MongoDB with Mongoose for domain models

The database is MongoDB (operational simplicity, document-shaped care data, docker-compose
friendliness). Drizzle ORM was considered and rejected as inapplicable — it is SQL-only
and cannot talk to MongoDB at all. Domain documents are modeled with Mongoose
(@nestjs/mongoose integration, schema validation, typing); persistence models stay
inside the API and map to/from shared-contract DTOs at the service boundary, so storage
concerns never leak to the client. BetterAuth's own tables use the native driver
instead (see ADR-0004); the two client stacks coexist on one database. The health
probe additionally types against the native `mongodb` package's `Db` handle (obtained
from the Mongoose connection) for infra-level ping checks — a deliberate exception,
not a domain-data access path.
