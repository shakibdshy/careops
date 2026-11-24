// Package auth implements the BetterAuth-compatible identity plane for the
// Go replica (Go-T09): Argon2id password hashing, opaque bearer session
// tokens stored as SHA-256 hashes, and the five auth operations the web
// client uses, with the same wire shapes and cookie behavior as the
// reference (ADR-0004's compatibility boundary).
package auth

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"fmt"
	"strings"

	"golang.org/x/crypto/argon2"
)

// Argon2id parameters (documented per the spec's decision record): memory
// cost dominates GPU cracking; time cost 1 with 64 MiB keeps sign-in under
// ~100 ms on the Fargate sizing.
const (
	argonTime    = 1
	argonMemory  = 64 * 1024 // KiB
	argonThreads = 1
	argonKeyLen  = 32
	argonSaltLen = 16
)

// MinPasswordLength matches BetterAuth's default policy.
const MinPasswordLength = 8

// ErrWeakPassword is returned for a password below the minimum length.
var ErrWeakPassword = fmt.Errorf("password must be at least %d characters", MinPasswordLength)

// HashPassword derives an Argon2id PHC string: the salt is fresh per hash,
// so two equal passwords never share a stored digest.
func HashPassword(password string) (string, error) {
	if len(password) < MinPasswordLength {
		return "", ErrWeakPassword
	}
	salt := make([]byte, argonSaltLen)
	if _, err := rand.Read(salt); err != nil {
		return "", fmt.Errorf("password: salt: %w", err)
	}
	key := argon2.IDKey([]byte(password), salt, argonTime, argonMemory, argonThreads, argonKeyLen)
	return fmt.Sprintf("$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s",
		argon2.Version, argonMemory, argonTime, argonThreads,
		base64.RawStdEncoding.EncodeToString(salt),
		base64.RawStdEncoding.EncodeToString(key),
	), nil
}

// VerifyPassword checks a plaintext password against a stored PHC string in
// constant time. Unknown-format hashes verify false rather than panicking.
func VerifyPassword(password, encoded string) bool {
	parts := strings.Split(encoded, "$")
	// "", "argon2id", "v=19", "m=...,t=...,p=...", salt, hash
	if len(parts) != 6 || parts[1] != "argon2id" {
		return false
	}
	var version int
	if _, err := fmt.Sscanf(parts[2], "v=%d", &version); err != nil {
		return false
	}
	var memory, time uint32
	var threads uint8
	if _, err := fmt.Sscanf(parts[3], "m=%d,t=%d,p=%d", &memory, &time, &threads); err != nil {
		return false
	}
	salt, err := base64.RawStdEncoding.DecodeString(parts[4])
	if err != nil {
		return false
	}
	want, err := base64.RawStdEncoding.DecodeString(parts[5])
	if err != nil {
		return false
	}
	got := argon2.IDKey([]byte(password), salt, time, memory, threads, uint32(len(want)))
	return subtle.ConstantTimeCompare(got, want) == 1
}
