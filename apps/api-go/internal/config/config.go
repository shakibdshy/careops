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

// Config carries everything the server needs to boot. Every field is required
// unless noted; a missing or malformed variable aborts startup.
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
	return cfg, nil
}
