// Package server wires the generated contract surface (Go-T05 skeleton,
// Postgres added in Go-T06). Every domain route answers the shared error
// taxonomy with 501 until its ticket implements it — the parity ledger in
// packages/contract then sees a real HTTP failure instead of a missing
// route. Health and the committed OpenAPI documents are served for real
// from day one.
package server

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
	"github.com/shakibdshy/careops/api-go/gen"
	"github.com/shakibdshy/careops/api-go/internal/auth"
	"github.com/shakibdshy/careops/api-go/internal/store"

	_ "embed"
)

//go:embed docs.html
var docsPage []byte

// Config is the subset of server configuration the handlers need.
type Config struct {
	ServiceName      string
	Implementation   string
	CommitOpenAPIDir string
	// Pool is the restricted app-role pool; health reports its reachability
	// under the `postgres` dependency key (the stated parity exception).
	Pool *pgxpool.Pool
	// Auth carries the identity-plane service (Go-T09).
	Auth *auth.Service
	// RDB is the Redis client backing the report cache (nil = uncached).
	RDB *redis.Client
	// TrustedOrigins names the origins state-changing auth routes accept.
	TrustedOrigins []string
}

// Server implements gen.ServerInterface. Domain methods are explicit 501
// stubs; each names its area, matching the parity ledger entries in
// packages/contract. Health and the document serving are real.
type Server struct {
	cfg  Config
	auth *auth.Service
	rdb  *redis.Client
}

func New(cfg Config) *Server {
	var rdb *redis.Client
	if cfg.RDB != nil {
		rdb = cfg.RDB
	}
	return &Server{cfg: cfg, auth: cfg.Auth, rdb: rdb}
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(body); err != nil {
		slog.Error("encode response", "err", err)
	}
}

// Health reports status, the shared service identity, the implementation,
// and every data-plane dependency: Postgres under the `postgres` key (the
// stated parity exception — the reference reports mongo) and Redis under
// `redis` like the reference, since the report cache is a real dependency
// here too. Unauthenticated by design, like the reference.
func (s *Server) HealthControllerCheck(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 500*time.Millisecond)
	defer cancel()

	postgres := "up"
	redisUp := "up"
	status := "ok"
	if err := s.cfg.Pool.Ping(ctx); err != nil {
		slog.Warn("postgres unreachable", "err", err)
		postgres = "down"
		status = "degraded"
	}
	if s.rdb != nil {
		if err := s.rdb.Ping(ctx).Err(); err != nil {
			slog.Warn("redis unreachable", "err", err)
			redisUp = "down"
			status = "degraded"
		}
	}

	writeJSON(w, http.StatusOK, map[string]string{
		"status":         status,
		"service":        s.cfg.ServiceName,
		"implementation": s.cfg.Implementation,
		"postgres":       postgres,
		"redis":          redisUp,
	})
}

// ServeCommittedDoc answers /api/docs-json (and /api/docs-json/auth) from the
// committed contract artifacts — the Go service serves exactly what the
// reference publishes, never a hand-maintained variant (ADR-0015).
func (s *Server) ServeCommittedDoc(name string) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		path := filepath.Join(s.cfg.CommitOpenAPIDir, name)
		data, err := os.ReadFile(path)
		if err != nil {
			slog.Error("read committed contract", "path", path, "err", err)
			writeJSON(w, http.StatusInternalServerError, map[string]any{
				"statusCode": http.StatusInternalServerError,
				"message":    "committed contract artifact unavailable",
				"errors":     []any{},
			})
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(data)
	}
}

// DocsPage serves a minimal page in front of the committed documents (the
// reference serves Swagger UI; the replica's page links the raw artifacts).
func (s *Server) DocsPage(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_, _ = w.Write(docsPage)
}

// AdminProbe mirrors the reference's docs-excluded RBAC probe: 200 only for
// admin/owner members. Role resolution arrives with Go-T09; until then the
// probe answers 501 like every other ledgered route (the conformance RBAC
// cases run against it).
// AdminProbe mirrors the reference's docs-excluded RBAC probe: 200 only
// for admin/owner members, the shared taxonomy's 403 otherwise, with the
// reference's exact message shape.
func (s *Server) AdminProbe(w http.ResponseWriter, r *http.Request) {
	org, failure := s.resolve(r)
	if failure != nil {
		failure.write(w)
		return
	}
	if !managerRoles[org.Role] {
		writeTaxonomy(w, http.StatusForbidden, org.forbiddenMessage())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// ExtraRoutes registers the surfaces that live outside the generated
// interface: the BetterAuth-compatible auth routes (Go-T09) and the
// docs-excluded RBAC probe (excluded from the reference's OpenAPI too).
func (s *Server) ExtraRoutes(mux *http.ServeMux) {
	s.registerAuthRoutes(mux)
	mux.HandleFunc("GET /api/workspace/admin-probe", s.AdminProbe)
}

// --- gen.ServerInterface: implemented + ledgered stubs ----------------------

var _ gen.ServerInterface = (*Server)(nil)

// OrganizationsControllerCurrent serves the RBAC surface: the active
// Organization and every member with their role (the org-current schema).
func (s *Server) OrganizationsControllerCurrent(w http.ResponseWriter, r *http.Request) {
	org, failure := s.resolve(r)
	if failure != nil {
		failure.write(w)
		return
	}

	members, err := store.New(s.cfg.Pool).ListMembers(r.Context(), uuidParam(org.OrganizationID))
	if err != nil {
		writeTaxonomy(w, http.StatusInternalServerError, "failed to list members")
		return
	}
	memberViews := make([]map[string]any, 0, len(members))
	for _, m := range members {
		memberViews = append(memberViews, map[string]any{
			"id":     uidString(m.ID),
			"userId": uidString(m.UserID),
			"email":  m.Email,
			"name":   m.Name,
			"role":   normalizeRole(m.Role),
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"id":      org.OrganizationID,
		"name":    org.OrganizationName,
		"slug":    org.Slug,
		"members": memberViews,
	})
}

// OrganizationsControllerInvite creates a pending invitation. Manager-only
// (the shared MANAGER_ROLES rule), validated with field-level taxonomy
// errors exactly like the reference.
func (s *Server) OrganizationsControllerInvite(w http.ResponseWriter, r *http.Request) {
	org, failure := s.resolve(r)
	if failure != nil {
		failure.write(w)
		return
	}
	if !managerRoles[org.Role] {
		writeTaxonomy(w, http.StatusForbidden, org.forbiddenMessage())
		return
	}
	var body struct {
		Email string `json:"email"`
		Role  string `json:"role"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeTaxonomy(w, http.StatusBadRequest, "request body is not valid JSON")
		return
	}
	fieldErrors := []map[string]string{}
	if !validEmail(body.Email) {
		fieldErrors = append(fieldErrors, map[string]string{"field": "email", "message": "must be a valid email address"})
	}
	if body.Role != "admin" && body.Role != "member" {
		fieldErrors = append(fieldErrors, map[string]string{"field": "role", "message": "must be admin or member"})
	}
	if len(fieldErrors) > 0 {
		writeJSON(w, http.StatusBadRequest, map[string]any{
			"statusCode": http.StatusBadRequest,
			"message":    "Validation failed",
			"errors":     fieldErrors,
		})
		return
	}
	invitation, err := store.New(s.cfg.Pool).CreateInvitation(r.Context(), store.CreateInvitationParams{
		OrganizationID: uuidParam(org.OrganizationID),
		Email:          strings.ToLower(body.Email),
		Role:           body.Role,
		InviterID:      uuidParam(org.UserID),
	})
	if err != nil {
		writeTaxonomy(w, http.StatusInternalServerError, "failed to create invitation")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		"id":             uidString(invitation.ID),
		"email":          invitation.Email,
		"role":           invitation.Role,
		"status":         invitation.Status,
		"organizationId": uidString(invitation.OrganizationID),
	})
}

// OrganizationsControllerInvitation serves one invitation, scoped to the
// caller's Organization (a cross-org id is a 404, never a 403).
func (s *Server) OrganizationsControllerInvitation(w http.ResponseWriter, r *http.Request, invitationID string) {
	org, failure := s.resolve(r)
	if failure != nil {
		failure.write(w)
		return
	}
	invitation, err := store.New(s.cfg.Pool).GetInvitation(r.Context(), uuidParam(invitationID))
	if err != nil || uidString(invitation.OrganizationID) != org.OrganizationID {
		writeTaxonomy(w, http.StatusNotFound, "Invitation not found")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"id":             uidString(invitation.ID),
		"email":          invitation.Email,
		"role":           invitation.Role,
		"status":         invitation.Status,
		"organizationId": uidString(invitation.OrganizationID),
	})
}

// WorkspaceControllerMe answers who the caller is acting as: the verified
// session user plus the active Organization and the caller's role in it.
func (s *Server) WorkspaceControllerMe(w http.ResponseWriter, r *http.Request) {
	org, failure := s.resolve(r)
	if failure != nil {
		failure.write(w)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"user": map[string]string{
			"id":    org.UserID,
			"email": org.Email,
			"name":  org.Name,
		},
		"organization": map[string]string{
			"id":   org.OrganizationID,
			"name": org.OrganizationName,
			"role": org.Role,
		},
	})
}
