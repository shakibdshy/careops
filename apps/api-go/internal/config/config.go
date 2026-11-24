// Server config from the environment, validated at startup: the service
// fails fast with a clear message rather than booting into a half-configured
// state (the same contract as the reference API's Zod env schema).
package config

import (
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
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
	// TrustedOrigins are the origins state-changing auth routes accept.
	TrustedOrigins []string
	// SMTPURL is the delivery endpoint for notifications (Mailpit locally).
	SMTPURL string
	// MailFrom is the envelope sender for outgoing notifications.
	MailFrom string
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

	cfg.SMTPURL = "smtp://localhost:1025"
	if v := os.Getenv("SMTP_URL"); v != "" {
		cfg.SMTPURL = v
	}
	cfg.MailFrom = "CareOps <no-reply@careops.local>"
	if v := os.Getenv("MAIL_FROM"); v != "" {
		cfg.MailFrom = v
	}

	cfg.DatabaseURL = os.Getenv("DATABASE_URL")
	if cfg.DatabaseURL == "" {
		return cfg, errors.New("DATABASE_URL: required (the app-role PostgreSQL connection)")
	}
	cfg.MigrationsDatabaseURL = os.Getenv("MIGRATIONS_DATABASE_URL")
	if cfg.MigrationsDatabaseURL == "" {
		return cfg, errors.New("MIGRATIONS_DATABASE_URL: required (the owner connection for the migration runner)")
	}

	// Trusted origins for state-changing auth routes (BetterAuth semantics):
	// the local web dev origin by default, plus BETTER_AUTH_URL and any
	// TRUSTED_ORIGINS csv for named deployments.
	cfg.TrustedOrigins = []string{"http://localhost:3000"}
	if v := os.Getenv("BETTER_AUTH_URL"); v != "" {
		cfg.TrustedOrigins = append(cfg.TrustedOrigins, v)
	}
	if v := os.Getenv("TRUSTED_ORIGINS"); v != "" {
		for _, origin := range strings.Split(v, ",") {
			if trimmed := strings.TrimSpace(origin); trimmed != "" {
				cfg.TrustedOrigins = append(cfg.TrustedOrigins, trimmed)
			}
		}
	}
	return cfg, nil
}
