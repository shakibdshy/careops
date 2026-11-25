-- Auth + organization queries (Go-T09). Identity-plane access is global by
-- design (ADR-0018): users are looked up by email before any Organization
-- context exists. Everything Organization-scoped here is still called inside
-- db.OrgTx where handlers have already resolved a session.

-- name: GetUserByEmail :one
SELECT * FROM app_user WHERE email = $1;

-- name: GetUserByID :one
SELECT * FROM app_user WHERE id = $1;

-- name: CreateUser :one
INSERT INTO app_user (email, name, password_hash)
VALUES ($1, $2, $3)
RETURNING *;

-- name: CreateSession :one
INSERT INTO session (user_id, token_hash, expires_at)
VALUES ($1, $2, $3)
RETURNING *;

-- name: GetSessionByTokenHash :one
SELECT s.*, u.email AS user_email, u.name AS user_name
FROM session s
JOIN app_user u ON u.id = s.user_id
WHERE s.token_hash = $1 AND s.expires_at > now();

-- name: DeleteSession :execrows
DELETE FROM session WHERE token_hash = $1;

-- name: SetActiveOrganization :exec
UPDATE session SET active_organization_id = $1 WHERE token_hash = $2;

-- name: GetOrganization :one
SELECT * FROM organization WHERE id = $1;

-- name: CreateOrganization :one
INSERT INTO organization (name, slug, owner_user_id)
VALUES ($1, $2, $3)
RETURNING *;

-- name: GetMembership :one
SELECT * FROM organization_member
WHERE organization_id = $1 AND user_id = $2;

-- name: GetFirstMembershipByUser :one
SELECT * FROM organization_member WHERE user_id = $1 ORDER BY id LIMIT 1;

-- name: CreateMember :one
INSERT INTO organization_member (organization_id, user_id, role)
VALUES ($1, $2, $3)
RETURNING *;

-- name: ListMembers :many
SELECT m.id, m.user_id, m.role, u.email, u.name
FROM organization_member m
JOIN app_user u ON u.id = m.user_id
WHERE m.organization_id = $1
ORDER BY m.id;

-- name: CreateInvitation :one
INSERT INTO organization_invitation (organization_id, email, role, inviter_id)
VALUES ($1, $2, $3, $4)
RETURNING *;

-- name: GetInvitation :one
SELECT i.*, o.name AS organization_name
FROM organization_invitation i
JOIN organization o ON o.id = i.organization_id
WHERE i.id = $1;

-- name: AcceptInvitation :one
UPDATE organization_invitation
SET status = 'accepted'
WHERE id = $1 AND status = 'pending'
RETURNING *;
