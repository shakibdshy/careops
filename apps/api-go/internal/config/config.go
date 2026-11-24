// Server config from the environment, validated at startup: the service
// fails fast with a clear message rather than booting into a half-configured
// state (the same contract as the reference API's Zod env schema).
package config

import (
	"errors"
	"fmt"
	"os"
	"strconv"
)

// Config carries everything the server needs to boot. DATABASE_URL and
// MIGRATIONS_DATABASE_URL are required: the app connects as the restricted
// careops_app role, while migrations run as the owner (they create roles and
// policies, which the app role must not do — ADR-0018).
type Config struct {
	// Port is the HTTP listen port (PORT).
	Port int
	// ServiceName is the identity reported on health and in logs
	// (SERVICE_NAME; fixed to the shared identity in practice).
	ServiceName string
	// Implementation names the backend on the health response
	// (IMPLEMENTATION; "go").
	Implementation string
	// CommitOpenAPIDir points at the committed contract artifacts
	// (CONTRACT_OPENAPI_DIR; overridden only in tests).
	CommitOpenAPIDir string
	// DatabaseURL is the app-role connection string (DATABASE_URL).
	DatabaseURL string
	// MigrationsDatabaseURL is the owner connection string used by the
	// migration runner (MIGRATIONS_DATABASE_URL).
	MigrationsDatabaseURL string
}

func Load() (Config, error) {
	cfg := Config{
		Port:             3102,
		ServiceName:      "careops-api",
		Implementation:   "go",
		CommitOpenAPIDir: "../../packages/contract/openapi",
	}

	if v := os.Getenv("PORT"); v != "" {
		port, err := strconv.Atoi(v)
		if err != nil || port < 1 || port > 65535 {
			return cfg, fmt.Errorf("PORT: expected a port number, got %q", v)
		}
		cfg.Port = port
	}
	if v := os.Getenv("SERVICE_NAME"); v != "" {
		cfg.ServiceName = v
	}
	if v := os.Getenv("IMPLEMENTATION"); v != "" {
		cfg.Implementation = v
	}
	if v := os.Getenv("CONTRACT_OPENAPI_DIR"); v != "" {
		cfg.CommitOpenAPIDir = v
	}
	if cfg.CommitOpenAPIDir == "" {
		return cfg, errors.New("CONTRACT_OPENAPI_DIR: no committed contract directory configured")
	}

	cfg.DatabaseURL = os.Getenv("DATABASE_URL")
	if cfg.DatabaseURL == "" {
		return cfg, errors.New("DATABASE_URL: required (the app-role PostgreSQL connection)")
	}
	cfg.MigrationsDatabaseURL = os.Getenv("MIGRATIONS_DATABASE_URL")
	if cfg.MigrationsDatabaseURL == "" {
		return cfg, errors.New("MIGRATIONS_DATABASE_URL: required (the owner connection for the migration runner)")
	}
	return cfg, nil
}
