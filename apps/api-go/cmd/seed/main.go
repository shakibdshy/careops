// The Go replica's demo seed (Go-T18): creates the same demo Organization
// and demo Members as apps/api/src/seed.ts — same emails, names, and demo
// password — so both live links accept identical demo credentials.
//
// Safe to re-run: every insert is idempotent on its natural key.
package main

import (
	"context"
	"log/slog"
	"os"

	"github.com/shakibdshy/careops/api-go/internal/auth"
	"github.com/shakibdshy/careops/api-go/internal/config"
	"github.com/shakibdshy/careops/api-go/internal/db"
)

// demoMember mirrors apps/api/src/seed.ts's demo trio.
type demoMember struct {
	email string
	name  string
	role  string
}

var demoMembers = []demoMember{
	{email: "owner@demo.careops", name: "Dana Owner", role: "owner"},
	{email: "admin@demo.careops", name: "Alex Admin", role: "admin"},
	{email: "member@demo.careops", name: "Morgan Member", role: "member"},
}

const (
	// demoPassword is the same shared demo credential the reference seeds.
	demoPassword = "careops-demo-1"
	// demoOrgSlug is fixed so re-runs and the parity check key on the same org.
	demoOrgSlug = "careops-demo"
)

func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, nil)))

	cfg, err := config.Load()
	if err != nil {
		slog.Error("invalid configuration", "err", err)
		os.Exit(1)
	}

	ctx := context.Background()
	if err := db.Migrate(ctx, cfg.MigrationsDatabaseURL); err != nil {
		slog.Error("migrations failed", "err", err)
		os.Exit(1)
	}
	pool, err := db.Connect(ctx, cfg.DatabaseURL)
	if err != nil {
		slog.Error("database connect failed", "err", err)
		os.Exit(1)
	}
	defer pool.Close()

	hash, err := auth.HashPassword(demoPassword)
	if err != nil {
		slog.Error("hash demo password failed", "err", err)
		os.Exit(1)
	}

	for _, member := range demoMembers {
		if _, err := pool.Exec(ctx,
			`INSERT INTO app_user (email, name, password_hash)
			 VALUES ($1, $2, $3)
			 ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash`,
			member.email, member.name, hash); err != nil {
			slog.Error("seed member failed", "email", member.email, "err", err)
			os.Exit(1)
		}
	}

	// The Organization is created the same way the reference's signup hook
	// names it ('<Owner>'s Organization', slug careops-demo), owned by the
	// demo owner, with all three demo Members inside it.
	if _, err := pool.Exec(ctx,
		`INSERT INTO organization (name, slug, owner_user_id)
		 SELECT $1, $2, id FROM app_user WHERE email = $3
		 ON CONFLICT (slug) DO NOTHING`,
		"Dana Owner's Organization", demoOrgSlug, demoMembers[0].email); err != nil {
		slog.Error("seed organization failed", "err", err)
		os.Exit(1)
	}
	for _, member := range demoMembers {
		if _, err := pool.Exec(ctx,
			`INSERT INTO organization_member (organization_id, user_id, role)
			 SELECT o.id, u.id, CAST($1 AS text)
			 FROM organization o, app_user u
			 WHERE o.slug = CAST($3 AS text) AND u.email = CAST($2 AS text)
			 ON CONFLICT (organization_id, user_id) DO NOTHING`,
			member.role, member.email, demoOrgSlug); err != nil {
			slog.Error("seed membership failed", "email", member.email, "err", err)
			os.Exit(1)
		}
	}

	slog.Info("demo seed complete",
		"organization", "Dana Owner's Organization (slug "+demoOrgSlug+")",
		"members", len(demoMembers),
		"credentials", "owner@demo.careops / "+demoPassword,
	)
}
