// The auth service (Go-T09): the five operations the web client uses, over
// the identity plane. Multi-write operations (sign-up creating the user's
// Organization, accepting an invitation joining it) run in one transaction —
// a user never exists without their Organization and owner membership.
package auth

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/shakibdshy/careops/api-go/internal/store"
)

// AuthError is the BetterAuth-compatible error shape for the auth surface:
// a machine-readable code, a human message, and an HTTP status (ADR-0004's
// boundary — auth endpoints speak this shape, not the domain taxonomy).
type AuthError struct {
	Code    string
	Message string
	Status  int
}

func (e *AuthError) Error() string { return e.Code + ": " + e.Message }

func authErr(status int, code, message string) *AuthError {
	return &AuthError{Code: code, Message: message, Status: status}
}

// User is the identity the web client sees.
type User struct {
	ID    string
	Email string
	Name  string
}

// Session is the live session as the surface needs it.
type Session struct {
	ID                   string
	UserID               string
	ActiveOrganizationID string
	ExpiresAt            time.Time
}

// Service implements the auth operations over the identity plane.
type Service struct {
	Pool *pgxpool.Pool
	Now  func() time.Time // overridable in tests
}

func NewService(pool *pgxpool.Pool) *Service {
	return &Service{Pool: pool, Now: time.Now}
}

// SignUp creates the user, their Organization (named and slugged exactly
// like the reference's signup hook), and their owner membership in one
// transaction, then opens a session.
func (s *Service) SignUp(ctx context.Context, name, email, password string) (User, Session, string, error) {
	name = strings.TrimSpace(name)
	email = strings.ToLower(strings.TrimSpace(email))
	if name == "" || email == "" {
		return User{}, Session{}, "", authErr(400, "INVALID_INPUT", "name and email are required")
	}
	if !ValidEmail(email) {
		return User{}, Session{}, "", authErr(400, "INVALID_EMAIL", "email is not a valid address")
	}
	hash, err := HashPassword(password)
	if err != nil {
		return User{}, Session{}, "", authErr(400, "INVALID_PASSWORD", ErrWeakPassword.Error())
	}

	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return User{}, Session{}, "", fmt.Errorf("sign up: begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	queries := store.New(tx)
	user, err := queries.CreateUser(ctx, store.CreateUserParams{
		Email:        email,
		Name:         name,
		PasswordHash: hash,
	})
	if err != nil {
		if isUniqueViolation(err) {
			return User{}, Session{}, "", authErr(422, "USER_ALREADY_EXISTS", "this email is already registered")
		}
		return User{}, Session{}, "", fmt.Errorf("sign up: create user: %w", err)
	}

	// Same naming the reference's signup hook uses, including the slug.
	org, err := queries.CreateOrganization(ctx, store.CreateOrganizationParams{
		Name:        fmt.Sprintf("%s's Organization", name),
		Slug:        pgtypeText("org-" + UIDString(user.ID)),
		OwnerUserID: user.ID,
	})
	if err != nil {
		return User{}, Session{}, "", fmt.Errorf("sign up: create organization: %w", err)
	}
	if _, err := queries.CreateMember(ctx, store.CreateMemberParams{
		OrganizationID: org.ID,
		UserID:         user.ID,
		Role:           "owner",
	}); err != nil {
		return User{}, Session{}, "", fmt.Errorf("sign up: create owner member: %w", err)
	}

	sess, token, err := s.createSession(ctx, tx, UIDString(user.ID))
	if err != nil {
		return User{}, Session{}, "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return User{}, Session{}, "", fmt.Errorf("sign up: commit: %w", err)
	}
	return User{ID: UIDString(user.ID), Email: user.Email, Name: user.Name}, sess, token, nil
}

// SignIn verifies credentials and opens a session. Unknown email and wrong
// password produce the identical error: no account enumeration.
func (s *Service) SignIn(ctx context.Context, email, password string) (User, Session, string, error) {
	queries := store.New(s.Pool)
	user, err := queries.GetUserByEmail(ctx, strings.ToLower(strings.TrimSpace(email)))
	if err != nil || !VerifyPassword(password, user.PasswordHash) {
		return User{}, Session{}, "", authErr(401, "INVALID_EMAIL_OR_PASSWORD", "invalid email or password")
	}

	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return User{}, Session{}, "", fmt.Errorf("sign in: begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	sess, token, err := s.createSession(ctx, tx, UIDString(user.ID))
	if err != nil {
		return User{}, Session{}, "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return User{}, Session{}, "", fmt.Errorf("sign in: commit: %w", err)
	}
	return User{ID: UIDString(user.ID), Email: user.Email, Name: user.Name}, sess, token, nil
}

// SignOut deletes the session for a token. Idempotent: an unknown or already
// expired token is still a successful sign-out.
func (s *Service) SignOut(ctx context.Context, token string) error {
	_, err := store.New(s.Pool).DeleteSession(ctx, HashToken(token))
	return err
}

// SessionFor resolves a live session (and its user) from a bearer token.
// Expired and unknown tokens both resolve to pgx.ErrNoRows.
func (s *Service) SessionFor(ctx context.Context, token string) (User, Session, error) {
	row, err := store.New(s.Pool).GetSessionByTokenHash(ctx, HashToken(token))
	if err != nil {
		return User{}, Session{}, err
	}
	return User{
		ID:    UIDString(row.UserID),
		Email: row.UserEmail,
		Name:  row.UserName,
	}, Session{
		ID:                   UIDString(row.ID),
		UserID:               UIDString(row.UserID),
		ActiveOrganizationID: UIDString(row.ActiveOrganizationID),
		ExpiresAt:            row.ExpiresAt.Time,
	}, nil
}

// AcceptInvitation joins the invitation's Organization as the invited user
// and makes it the session's active Organization, in the same transaction
// that marks the invitation accepted — BetterAuth's accept does both, so
// the invitee lands inside the Organization on their next request. The
// invited email must match the session user's: an invitation is not
// transferable.
func (s *Service) AcceptInvitation(ctx context.Context, user User, invitationID, tokenHash string) error {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("accept invitation: begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	queries := store.New(tx)
	invitation, err := queries.AcceptInvitation(ctx, UUIDParam(invitationID))
	if err != nil {
		return authErr(400, "INVITATION_INVALID", "invitation not found or no longer pending")
	}
	if !strings.EqualFold(invitation.Email, user.Email) {
		return authErr(403, "INVITATION_FORBIDDEN", "this invitation was sent to another email")
	}
	if _, err := queries.CreateMember(ctx, store.CreateMemberParams{
		OrganizationID: invitation.OrganizationID,
		UserID:         UUIDParam(user.ID),
		Role:           invitation.Role,
	}); err != nil {
		if isUniqueViolation(err) {
			return authErr(400, "INVITATION_INVALID", "already a member of this organization")
		}
		return fmt.Errorf("accept invitation: create member: %w", err)
	}
	// BetterAuth's accept also makes the joined Organization the session's
	// active one — without this the org-context fallback would pick the
	// caller's FIRST membership by random uuid order, and the tenant would
	// be nondeterministic (the conformance suite caught exactly that).
	if err := queries.SetActiveOrganization(ctx, store.SetActiveOrganizationParams{
		ActiveOrganizationID: invitation.OrganizationID,
		TokenHash:            tokenHash,
	}); err != nil {
		return fmt.Errorf("accept invitation: activate organization: %w", err)
	}
	return tx.Commit(ctx)
}

// SetActiveOrganization pins the session's active Organization. Membership
// in that Organization is required — a session cannot activate itself into
// a tenant it does not belong to.
func (s *Service) SetActiveOrganization(ctx context.Context, token, organizationID string) error {
	queries := store.New(s.Pool)
	sess, err := queries.GetSessionByTokenHash(ctx, HashToken(token))
	if err != nil {
		return authErr(401, "SESSION_REQUIRED", "no live session")
	}
	if _, err := queries.GetMembership(ctx, store.GetMembershipParams{
		OrganizationID: UUIDParam(organizationID),
		UserID:         sess.UserID,
	}); err != nil {
		return authErr(403, "MEMBERSHIP_REQUIRED", "not a member of that organization")
	}
	return queries.SetActiveOrganization(ctx, store.SetActiveOrganizationParams{
		ActiveOrganizationID: UUIDParam(organizationID),
		TokenHash:            HashToken(token),
	})
}

func (s *Service) createSession(ctx context.Context, tx pgx.Tx, userID string) (Session, string, error) {
	token, hash, err := NewSessionToken()
	if err != nil {
		return Session{}, "", fmt.Errorf("session: mint token: %w", err)
	}
	expires := s.Now().Add(SessionTokenTTL)
	row, err := store.New(tx).CreateSession(ctx, store.CreateSessionParams{
		UserID:    UUIDParam(userID),
		TokenHash: hash,
		ExpiresAt: pgtype.Timestamptz{Time: expires, Valid: true},
	})
	if err != nil {
		return Session{}, "", fmt.Errorf("session: create: %w", err)
	}
	return Session{ID: UIDString(row.ID), UserID: userID, ExpiresAt: expires}, token, nil
}
