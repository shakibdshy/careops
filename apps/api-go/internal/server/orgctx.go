// Org context resolution (Go-T09): the Go mirror of the reference's guard —
// session first, then the active Organization with the same first-membership
// fallback, then the caller's role. Domain routes resolve through this and
// Manager-only routes enforce the shared rule with the reference's wording.
package server

import (
	"context"
	"errors"
	"net/http"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/shakibdshy/careops/api-go/internal/auth"
	"github.com/shakibdshy/careops/api-go/internal/store"
)

// Server-local adapters over the auth package's type conversions, so the
// handlers read without qualifier noise.
func uuidParam(id string) pgtype.UUID { return auth.UUIDParam(id) }

func uidString(id pgtype.UUID) string { return auth.UIDString(id) }

func validEmail(email string) bool { return auth.ValidEmail(email) }

// OrgContext is what every protected route needs to act: who is calling,
// which Organization they are acting in, and their role in it.
type OrgContext struct {
	UserID           string
	Email            string
	Name             string
	OrganizationID   string
	OrganizationName string
	Slug             string
	Role             string
	Token            string
}

// forbiddenMessage is the reference's exact RBAC wording for a member
// calling a Manager-only route.
func (c OrgContext) forbiddenMessage() string {
	return "Requires role: admin or owner (you are " + c.Role + ")"
}

// AuthFailure carries a taxonomy-shaped failure from context resolution.
type AuthFailure struct {
	Status  int
	Message string
}

func (f *AuthFailure) write(w http.ResponseWriter) {
	writeTaxonomy(w, f.Status, f.Message)
}

func writeTaxonomy(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]any{
		"statusCode": status,
		"message":    message,
		"errors":     []any{},
	})
}

func asAuthError(err error) (*auth.AuthError, bool) {
	var authErr *auth.AuthError
	ok := errors.As(err, &authErr)
	return authErr, ok
}

// managerRoles is the shared MANAGER_ROLES rule, carried through the
// contract's role vocabulary.
var managerRoles = map[string]bool{"admin": true, "owner": true}

func normalizeRole(role string) string {
	switch role {
	case "owner", "admin", "member":
		return role
	default:
		// The reference validates BetterAuth role strings the same way: an
		// unexpected value degrades to member rather than escalating.
		return "member"
	}
}

// resolveOrgContext mirrors the reference's OrgContextGuard: the verified
// session, the active Organization (falling back to the user's first
// membership), and the caller's role in it.
// resolve runs the org-context guard for an incoming request.
func (s *Server) resolve(r *http.Request) (OrgContext, *AuthFailure) {
	return s.resolveOrgContext(r.Context(), sessionToken(r))
}

func (s *Server) resolveOrgContext(ctx context.Context, token string) (OrgContext, *AuthFailure) {
	if token == "" {
		return OrgContext{}, &AuthFailure{Status: http.StatusUnauthorized, Message: "Authentication required"}
	}
	svc := store.New(s.cfg.Pool)
	sess, err := svc.GetSessionByTokenHash(ctx, auth.HashToken(token))
	if err != nil {
		return OrgContext{}, &AuthFailure{Status: http.StatusUnauthorized, Message: "Authentication required"}
	}

	activeOrg := auth.UIDString(sess.ActiveOrganizationID)
	if activeOrg == "" {
		first, err := svc.GetFirstMembershipByUser(ctx, sess.UserID)
		if err != nil {
			return OrgContext{}, &AuthFailure{Status: http.StatusUnauthorized, Message: "No active organization"}
		}
		activeOrg = auth.UIDString(first.OrganizationID)
	}

	org, err := svc.GetOrganization(ctx, auth.UUIDParam(activeOrg))
	if err != nil {
		return OrgContext{}, &AuthFailure{Status: http.StatusUnauthorized, Message: "No active organization"}
	}
	member, err := svc.GetMembership(ctx, store.GetMembershipParams{
		OrganizationID: org.ID,
		UserID:         sess.UserID,
	})
	if err != nil {
		return OrgContext{}, &AuthFailure{Status: http.StatusUnauthorized, Message: "Not a member of the active organization"}
	}

	user, err := svc.GetUserByID(ctx, sess.UserID)
	if err != nil {
		return OrgContext{}, &AuthFailure{Status: http.StatusUnauthorized, Message: "Authentication required"}
	}

	return OrgContext{
		UserID:           auth.UIDString(sess.UserID),
		Email:            user.Email,
		Name:             user.Name,
		OrganizationID:   auth.UIDString(org.ID),
		OrganizationName: org.Name,
		Slug:             org.Slug.String,
		Role:             normalizeRole(member.Role),
		Token:            token,
	}, nil
}
