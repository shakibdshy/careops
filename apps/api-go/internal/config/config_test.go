package config

import (
	"reflect"
	"testing"
)

// Table-driven: the env contract is the public interface — each row is a
// caller story (unset optional variables fall back to defaults, a malformed
// PORT or a missing database URL refuses to boot), not an internal call.
func TestLoad(t *testing.T) {
	const testDB = "postgres://careops_app:pw@localhost:5433/careops_go"
	const testOwnerDB = "postgres://careops:pw@localhost:5433/careops_go"

	tests := []struct {
		name    string
		env     map[string]string
		want    Config
		wantErr string
	}{
		{
			name: "database URLs are the only required variables",
			env: map[string]string{
				"DATABASE_URL":            testDB,
				"MIGRATIONS_DATABASE_URL": testOwnerDB,
			},
			want: Config{
				Port:                  3102,
				ServiceName:           "careops-api",
				Implementation:        "go",
				CommitOpenAPIDir:      "../../packages/contract/openapi",
				DatabaseURL:           testDB,
				MigrationsDatabaseURL: testOwnerDB,
				RedisURL:              "redis://localhost:6379",
				TrustedOrigins:        []string{"http://localhost:3000"},
				SMTPURL:               "smtp://localhost:1025",
				MailFrom:              "CareOps <no-reply@careops.local>",
			},
		},
		{
			name: "explicit values override the defaults",
			env: map[string]string{
				"PORT":                    "8080",
				"SERVICE_NAME":            "careops-api-staging",
				"IMPLEMENTATION":          "go",
				"CONTRACT_OPENAPI_DIR":    "/app/openapi",
				"DATABASE_URL":            testDB,
				"MIGRATIONS_DATABASE_URL": testOwnerDB,
				"REDIS_URL":               "redis://localhost:6400",
			},
			want: Config{
				Port:                  8080,
				ServiceName:           "careops-api-staging",
				Implementation:        "go",
				CommitOpenAPIDir:      "/app/openapi",
				RedisURL:              "redis://localhost:6400",
				DatabaseURL:           testDB,
				MigrationsDatabaseURL: testOwnerDB,
				TrustedOrigins:        []string{"http://localhost:3000"},
				SMTPURL:               "smtp://localhost:1025",
				MailFrom:              "CareOps <no-reply@careops.local>",
			},
		},
		{
			name:    "a non-numeric PORT refuses to boot",
			env:     map[string]string{"PORT": "http", "DATABASE_URL": testDB, "MIGRATIONS_DATABASE_URL": testOwnerDB},
			wantErr: `PORT: expected a port number, got "http"`,
		},
		{
			name:    "an out-of-range PORT refuses to boot",
			env:     map[string]string{"PORT": "70000", "DATABASE_URL": testDB, "MIGRATIONS_DATABASE_URL": testOwnerDB},
			wantErr: `PORT: expected a port number, got "70000"`,
		},
		{
			name:    "a missing app-role database URL refuses to boot",
			env:     map[string]string{"MIGRATIONS_DATABASE_URL": testOwnerDB},
			wantErr: "DATABASE_URL: required (the app-role PostgreSQL connection)",
		},
		{
			name:    "a missing migration owner URL refuses to boot",
			env:     map[string]string{"DATABASE_URL": testDB},
			wantErr: "MIGRATIONS_DATABASE_URL: required (the owner connection for the migration runner)",
		},
	}

	envKeys := []string{
		"PORT", "SERVICE_NAME", "IMPLEMENTATION", "CONTRACT_OPENAPI_DIR",
		"DATABASE_URL", "MIGRATIONS_DATABASE_URL", "REDIS_URL",
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			for _, key := range envKeys {
				t.Setenv(key, "") // clear residue from a previous row first
				if v, ok := tt.env[key]; ok {
					t.Setenv(key, v)
				}
			}

			got, err := Load()
			if tt.wantErr != "" {
				if err == nil {
					t.Fatalf("Load() err = nil, want %q", tt.wantErr)
				}
				if err.Error() != tt.wantErr {
					t.Fatalf("Load() err = %q, want %q", err.Error(), tt.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("Load() unexpected err: %v", err)
			}
			if !reflect.DeepEqual(got, tt.want) {
				t.Fatalf("Load() = %+v, want %+v", got, tt.want)
			}
		})
	}
}
