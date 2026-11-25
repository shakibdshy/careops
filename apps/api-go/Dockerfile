# syntax=docker/dockerfile:1

# ---- build: compile the static binary (only the modules it imports) ----
FROM golang:1.27-alpine AS build
WORKDIR /src/apps/api-go
COPY apps/api-go/go.mod apps/api-go/go.sum ./
COPY apps/api-go ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/api-go ./cmd/server

# ---- runtime: distroless, non-root, no shell, no package manager ----
FROM gcr.io/distroless/static-debian12:nonroot
WORKDIR /app
COPY --from=build /out/api-go /app/api-go
# The committed contract artifacts are served verbatim (ADR-0015).
COPY packages/contract/openapi /app/openapi
ENV CONTRACT_OPENAPI_DIR=/app/openapi \
    PORT=3102
USER nonroot:nonroot
EXPOSE 3102
ENTRYPOINT ["/app/api-go"]
