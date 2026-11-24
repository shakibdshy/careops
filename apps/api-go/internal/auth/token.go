package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"time"
)

// SessionTokenTTL matches BetterAuth's default session lifetime.
const SessionTokenTTL = 7 * 24 * time.Hour

// NewSessionToken mints an opaque bearer token; only its SHA-256 hash is
// stored, so a database leak cannot be replayed as sessions.
func NewSessionToken() (token string, tokenHash string, err error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", "", err
	}
	token = base64.RawURLEncoding.EncodeToString(raw)
	return token, HashToken(token), nil
}

// HashToken is the storage form of a session token.
func HashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}
