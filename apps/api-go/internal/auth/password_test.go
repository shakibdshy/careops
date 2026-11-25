package auth

import (
	"errors"
	"strings"
	"testing"
)

func TestHashPassword(t *testing.T) {
	t.Run("hashes are PHC-formatted argon2id with a fresh salt", func(t *testing.T) {
		first, err := HashPassword("correct-horse-battery-staple")
		if err != nil {
			t.Fatalf("hash: %v", err)
		}
		second, err := HashPassword("correct-horse-battery-staple")
		if err != nil {
			t.Fatalf("hash: %v", err)
		}
		if !strings.HasPrefix(first, "$argon2id$v=19$m=65536,t=1,p=1$") {
			t.Fatalf("hash lacks the argon2id PHC prefix: %q", first[:40])
		}
		if first == second {
			t.Fatal("two hashes of the same password are identical — the salt is not fresh")
		}
	})

	t.Run("rejects a password below the minimum length", func(t *testing.T) {
		if _, err := HashPassword("short"); !errors.Is(err, ErrWeakPassword) {
			t.Fatalf("err = %v, want ErrWeakPassword", err)
		}
	})

	t.Run("verifies the right password and rejects the wrong one", func(t *testing.T) {
		encoded, err := HashPassword("correct-horse-battery-staple")
		if err != nil {
			t.Fatalf("hash: %v", err)
		}
		if !VerifyPassword("correct-horse-battery-staple", encoded) {
			t.Fatal("the correct password failed to verify")
		}
		if VerifyPassword("wrong-password", encoded) {
			t.Fatal("the wrong password verified")
		}
		if VerifyPassword("anything", "not-a-phc-string") {
			t.Fatal("a malformed hash verified")
		}
	})
}
