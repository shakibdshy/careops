// Package server wires the generated contract surface (Go-T05 skeleton).
// Every domain route answers the shared error taxonomy with 501 until its
// ticket implements it — the parity ledger in packages/contract then sees a
// real HTTP failure instead of a missing route. Health and the committed
// OpenAPI documents are served for real from day one.
package server

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"

	"github.com/shakibdshy/careops/api-go/gen"

	_ "embed"
)

//go:embed docs.html
var docsPage []byte

// Config is the subset of server configuration the handlers need.
type Config struct {
	ServiceName      string
	Implementation   string
	CommitOpenAPIDir string
}

// Server implements gen.ServerInterface. Domain methods are explicit 501
// stubs; each names its area, matching the parity ledger entries in
// packages/contract. Health and the document serving are real.
type Server struct {
	cfg Config
}

func New(cfg Config) *Server {
	return &Server{cfg: cfg}
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(body); err != nil {
		slog.Error("encode response", "err", err)
	}
}

func (s *Server) notImplemented(w http.ResponseWriter, area string) {
	writeJSON(w, http.StatusNotImplemented, map[string]any{
		"statusCode": http.StatusNotImplemented,
		"message":    "not implemented in the Go replica yet (parity ledger)",
		"errors":     []any{},
		"_area":      area,
	})
}

// Health reports status and the shared service identity plus the
// `implementation` field (spec #59: dependency keys are per-backend).
func (s *Server) HealthControllerCheck(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{
		"status":         "ok",
		"service":        s.cfg.ServiceName,
		"implementation": s.cfg.Implementation,
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
func (s *Server) AdminProbe(w http.ResponseWriter, _ *http.Request) {
	s.notImplemented(w, "organizations")
}

// ExtraRoutes registers the surface that is intentionally absent from the
// committed document (the reference excludes it from OpenAPI too).
func (s *Server) ExtraRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/workspace/admin-probe", s.AdminProbe)
}

// --- gen.ServerInterface: implemented + ledgered stubs ----------------------

var _ gen.ServerInterface = (*Server)(nil)

func (s *Server) AppointmentsControllerList(w http.ResponseWriter, _ *http.Request) {
	s.notImplemented(w, "appointments")
}

func (s *Server) AppointmentsControllerCreate(w http.ResponseWriter, _ *http.Request) {
	s.notImplemented(w, "appointments")
}

func (s *Server) AppointmentsControllerFindOne(w http.ResponseWriter, _ *http.Request, _ string) {
	s.notImplemented(w, "appointments")
}

func (s *Server) AppointmentsControllerReschedule(w http.ResponseWriter, _ *http.Request, _ string) {
	s.notImplemented(w, "appointments")
}

func (s *Server) AppointmentsControllerTransition(w http.ResponseWriter, _ *http.Request, _ string) {
	s.notImplemented(w, "appointments")
}

func (s *Server) AuditControllerList(w http.ResponseWriter, _ *http.Request) {
	s.notImplemented(w, "audit")
}

func (s *Server) OrganizationsControllerCurrent(w http.ResponseWriter, _ *http.Request) {
	s.notImplemented(w, "organizations")
}

func (s *Server) OrganizationsControllerInvite(w http.ResponseWriter, _ *http.Request) {
	s.notImplemented(w, "organizations")
}

func (s *Server) OrganizationsControllerInvitation(w http.ResponseWriter, _ *http.Request, _ string) {
	s.notImplemented(w, "organizations")
}

func (s *Server) PatientsControllerList(w http.ResponseWriter, _ *http.Request) {
	s.notImplemented(w, "patients")
}

func (s *Server) PatientsControllerCreate(w http.ResponseWriter, _ *http.Request) {
	s.notImplemented(w, "patients")
}

func (s *Server) PatientsControllerRemove(w http.ResponseWriter, _ *http.Request, _ string) {
	s.notImplemented(w, "patients")
}

func (s *Server) PatientsControllerFindOne(w http.ResponseWriter, _ *http.Request, _ string) {
	s.notImplemented(w, "patients")
}

func (s *Server) PatientsControllerUpdate(w http.ResponseWriter, _ *http.Request, _ string) {
	s.notImplemented(w, "patients")
}

func (s *Server) ReportsControllerDailyVolume(w http.ResponseWriter, _ *http.Request, _ gen.ReportsControllerDailyVolumeParams) {
	s.notImplemented(w, "reports")
}

func (s *Server) ReportsControllerProviderUtilization(w http.ResponseWriter, _ *http.Request, _ gen.ReportsControllerProviderUtilizationParams) {
	s.notImplemented(w, "reports")
}

func (s *Server) ReportsControllerStatusBreakdown(w http.ResponseWriter, _ *http.Request, _ gen.ReportsControllerStatusBreakdownParams) {
	s.notImplemented(w, "reports")
}

func (s *Server) ReportsControllerToday(w http.ResponseWriter, _ *http.Request) {
	s.notImplemented(w, "reports")
}

func (s *Server) WorkspaceControllerMe(w http.ResponseWriter, _ *http.Request) {
	s.notImplemented(w, "workspace")
}
