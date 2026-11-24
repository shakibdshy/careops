package config

import (
	"testing"
)

// Table-driven: the env contract is the public interface — each row is a
// caller story (unset variables fall back to defaults, a malformed PORT must
// refuse to boot), not an internal function call.
func TestLoad(t *testing.T) {
	tests := []struct {
		name    string
		env     map[string]string
		want    Config
		wantErr string
	}{
		{
			name: "defaults boot without any environment",
			env:  map[string]string{},
			want: Config{
				Port:             3102,
				ServiceName:      "careops-api",
				Implementation:   "go",
				CommitOpenAPIDir: "../../packages/contract/openapi",
			},
		},
		{
			name: "explicit values override the defaults",
			env: map[string]string{
				"PORT":                 "8080",
				"SERVICE_NAME":         "careops-api-staging",
				"IMPLEMENTATION":       "go",
				"CONTRACT_OPENAPI_DIR": "/app/openapi",
			},
			want: Config{
				Port:             8080,
				ServiceName:      "careops-api-staging",
				Implementation:   "go",
				CommitOpenAPIDir: "/app/openapi",
			},
		},
		{
			name:    "a non-numeric PORT refuses to boot",
			env:     map[string]string{"PORT": "http"},
			wantErr: `PORT: expected a port number, got "http"`,
		},
		{
			name:    "an out-of-range PORT refuses to boot",
			env:     map[string]string{"PORT": "70000"},
			wantErr: `PORT: expected a port number, got "70000"`,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			for _, key := range []string{"PORT", "SERVICE_NAME", "IMPLEMENTATION", "CONTRACT_OPENAPI_DIR"} {
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
			if got != tt.want {
				t.Fatalf("Load() = %+v, want %+v", got, tt.want)
			}
		})
	}
}
