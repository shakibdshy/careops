// The auth HTTP surface (Go-T09): the BetterAuth-compatible routes the web
// client and the conformance suite use — sign-up, sign-in, sign-out,
// session, invitation acceptance, set-active. Wire shapes, cookie behavior
// and error codes match the reference (ADR-0004): auth errors speak
// BetterAuth's {code, message}, not the domain taxonomy.
package server

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"

	"github.com/shakibdshy/careops/api-go/internal/auth"
)

const sessionCookie = "better-auth.session_token"

// state-changing auth routes must come from a trusted origin when the
// browser sends one; accept-invitation requires it outright (the reference's
// org plugin enforces the same).
func (s *Server) originAllowed(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true // non-browser clients (curl, supertest-style suites)
	}
	for _, trusted := range s.cfg.TrustedOrigins {
		if strings.EqualFold(origin, trusted) {
			return true
		}
	}
	return false
}

func writeAuthError(w http.ResponseWriter, err *auth.AuthError) {
	writeJSON(w, err.Status, map[string]string{"code": err.Code, "message": err.Message})
}

func setSessionCookie(w http.ResponseWriter, r *http.Request, token string) {
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookie,
		Value:    token,
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   r.TLS != nil,
		MaxAge:   7 * 24 * 60 * 60, // one week, in seconds
	})
}

func clearSessionCookie(w http.ResponseWriter, r *http.Request) {
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookie,
		Value:    "",
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   r.TLS != nil,
		MaxAge:   -1,
	})
}

// sessionToken reads the bearer session cookie from the request.
func sessionToken(r *http.Request) string {
	cookie, err := r.Cookie(sessionCookie)
	if err != nil {
		return ""
	}
	return cookie.Value
}

func decodeBody[T any](w http.ResponseWriter, r *http.Request, dst *T) bool {
	if err := json.NewDecoder(r.Body).Decode(dst); err != nil {
		writeAuthError(w, &auth.AuthError{Code: "INVALID_BODY", Message: "request body is not valid JSON", Status: http.StatusBadRequest})
		return false
	}
	return true
}

func (s *Server) registerAuthRoutes(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/auth/sign-up/email", s.handleSignUp)
	mux.HandleFunc("POST /api/auth/sign-in/email", s.handleSignIn)
	mux.HandleFunc("POST /api/auth/sign-out", s.handleSignOut)
	mux.HandleFunc("GET /api/auth/get-session", s.handleGetSession)
	mux.HandleFunc("POST /api/auth/organization/accept-invitation", s.handleAcceptInvitation)
	mux.HandleFunc("POST /api/auth/organization/set-active", s.handleSetActive)
}

func (s *Server) handleSignUp(w http.ResponseWriter, r *http.Request) {
	if !s.originAllowed(r) {
		writeAuthError(w, &auth.AuthError{Code: "UNTRUSTED_ORIGIN", Message: "origin is not trusted", Status: http.StatusForbidden})
		return
	}
	var body struct {
		Name     string `json:"name"`
		Email    string `json:"email"`
		Password string `json:"password"`
	}
	if !decodeBody(w, r, &body) {
		return
	}
	user, sess, token, err := s.auth.SignUp(r.Context(), body.Name, body.Email, body.Password)
	if err != nil {
		if authErr, ok := asAuthError(err); ok {
			writeAuthError(w, authErr)
			return
		}
		slog.Error("sign up", "err", err)
		writeAuthError(w, &auth.AuthError{Code: "INTERNAL", Message: "sign up failed", Status: http.StatusInternalServerError})
		return
	}
	setSessionCookie(w, r, token)
	writeJSON(w, http.StatusOK, map[string]any{
		"user":    map[string]string{"id": user.ID, "email": user.Email, "name": user.Name},
		"session": map[string]any{"id": sess.ID, "userId": sess.UserID, "expiresAt": sess.ExpiresAt},
	})
}

func (s *Server) handleSignIn(w http.ResponseWriter, r *http.Request) {
	if !s.originAllowed(r) {
		writeAuthError(w, &auth.AuthError{Code: "UNTRUSTED_ORIGIN", Message: "origin is not trusted", Status: http.StatusForbidden})
		return
	}
	var body struct {
		Email    string `json:"email"`
		Password string `json:"password"`
	}
	if !decodeBody(w, r, &body) {
		return
	}
	user, sess, token, err := s.auth.SignIn(r.Context(), body.Email, body.Password)
	if err != nil {
		if authErr, ok := asAuthError(err); ok {
			writeAuthError(w, authErr)
			return
		}
		slog.Error("sign in", "err", err)
		writeAuthError(w, &auth.AuthError{Code: "INTERNAL", Message: "sign in failed", Status: http.StatusInternalServerError})
		return
	}
	setSessionCookie(w, r, token)
	writeJSON(w, http.StatusOK, map[string]any{
		"user":    map[string]string{"id": user.ID, "email": user.Email, "name": user.Name},
		"session": map[string]any{"id": sess.ID, "userId": sess.UserID, "expiresAt": sess.ExpiresAt},
	})
}

func (s *Server) handleSignOut(w http.ResponseWriter, r *http.Request) {
	if !s.originAllowed(r) {
		writeAuthError(w, &auth.AuthError{Code: "UNTRUSTED_ORIGIN", Message: "origin is not trusted", Status: http.StatusForbidden})
		return
	}
	if err := s.auth.SignOut(r.Context(), sessionToken(r)); err != nil {
		slog.Error("sign out", "err", err)
		writeAuthError(w, &auth.AuthError{Code: "INTERNAL", Message: "sign out failed", Status: http.StatusInternalServerError})
		return
	}
	clearSessionCookie(w, r)
	writeJSON(w, http.StatusOK, map[string]any{})
}

func (s *Server) handleGetSession(w http.ResponseWriter, r *http.Request) {
	user, sess, err := s.auth.SessionFor(r.Context(), sessionToken(r))
	if err != nil {
		// BetterAuth returns literal null for no session (not an error).
		writeJSON(w, http.StatusOK, nil)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"user": map[string]string{"id": user.ID, "email": user.Email, "name": user.Name},
		"session": map[string]any{
			"id":                   sess.ID,
			"userId":               sess.UserID,
			"activeOrganizationId": sess.ActiveOrganizationID,
			"expiresAt":            sess.ExpiresAt,
		},
	})
}

func (s *Server) handleAcceptInvitation(w http.ResponseWriter, r *http.Request) {
	// Browsers always send Origin; the org plugin requires a trusted one on
	// accept (the conformance suite sends it the same way).
	if r.Header.Get("Origin") == "" || !s.originAllowed(r) {
		writeAuthError(w, &auth.AuthError{Code: "UNTRUSTED_ORIGIN", Message: "a trusted origin is required", Status: http.StatusForbidden})
		return
	}
	user, _, err := s.auth.SessionFor(r.Context(), sessionToken(r))
	if err != nil {
		writeAuthError(w, &auth.AuthError{Code: "SESSION_REQUIRED", Message: "authentication required", Status: http.StatusUnauthorized})
		return
	}
	var body struct {
		InvitationID string `json:"invitationId"`
	}
	if !decodeBody(w, r, &body) || body.InvitationID == "" {
		writeAuthError(w, &auth.AuthError{Code: "INVALID_INPUT", Message: "invitationId is required", Status: http.StatusBadRequest})
		return
	}
	if err := s.auth.AcceptInvitation(r.Context(), user, body.InvitationID, auth.HashToken(sessionToken(r))); err != nil {
		if authErr, ok := asAuthError(err); ok {
			writeAuthError(w, authErr)
			return
		}
		slog.Error("accept invitation", "err", err)
		writeAuthError(w, &auth.AuthError{Code: "INTERNAL", Message: "accept failed", Status: http.StatusInternalServerError})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"status": "accepted"})
}

func (s *Server) handleSetActive(w http.ResponseWriter, r *http.Request) {
	if !s.originAllowed(r) {
		writeAuthError(w, &auth.AuthError{Code: "UNTRUSTED_ORIGIN", Message: "origin is not trusted", Status: http.StatusForbidden})
		return
	}
	token := sessionToken(r)
	if token == "" {
		writeAuthError(w, &auth.AuthError{Code: "SESSION_REQUIRED", Message: "authentication required", Status: http.StatusUnauthorized})
		return
	}
	var body struct {
		OrganizationID string `json:"organizationId"`
	}
	if !decodeBody(w, r, &body) || body.OrganizationID == "" {
		writeAuthError(w, &auth.AuthError{Code: "INVALID_INPUT", Message: "organizationId is required", Status: http.StatusBadRequest})
		return
	}
	if err := s.auth.SetActiveOrganization(r.Context(), token, body.OrganizationID); err != nil {
		if authErr, ok := asAuthError(err); ok {
			writeAuthError(w, authErr)
			return
		}
		slog.Error("set active organization", "err", err)
		writeAuthError(w, &auth.AuthError{Code: "INTERNAL", Message: "set-active failed", Status: http.StatusInternalServerError})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"status": "active"})
}
