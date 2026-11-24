// The Go replica's entrypoint (Go-T05, extended by Go-T06): config from the
// environment (fail fast), forward-only migrations applied as the owner
// before anything listens, the restricted app-role pool, the generated
// contract surface on a std net/http mux, JSON request logs, and graceful
// shutdown on SIGINT/SIGTERM.
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/shakibdshy/careops/api-go/gen"
	"github.com/shakibdshy/careops/api-go/internal/auth"
	"github.com/shakibdshy/careops/api-go/internal/config"
	"github.com/shakibdshy/careops/api-go/internal/db"
	"github.com/shakibdshy/careops/api-go/internal/notifications"
	"github.com/shakibdshy/careops/api-go/internal/server"
)

func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, nil)))

	cfg, err := config.Load()
	if err != nil {
		slog.Error("invalid configuration", "err", err)
		os.Exit(1)
	}

	// Migrations run before the service listens (ADR-0014): schema and code
	// always ship together, and the app role never sees an un-migrated db.
	// The owner connection creates roles and policies; the app role must not.
	migrateCtx, cancelMigrate := context.WithTimeout(context.Background(), 60*time.Second)
	if err := db.Migrate(migrateCtx, cfg.MigrationsDatabaseURL); err != nil {
		cancelMigrate()
		slog.Error("migrations failed", "err", err)
		os.Exit(1)
	}
	cancelMigrate()

	pool, err := db.Connect(context.Background(), cfg.DatabaseURL)
	if err != nil {
		slog.Error("database connect failed", "err", err)
		os.Exit(1)
	}
	defer pool.Close()

	// The notification worker runs in-process (ADR-0017): safe on several
	// replicas (FOR UPDATE SKIP LOCKED claims) and cancelled with the server.
	workerCtx, cancelWorker := context.WithCancel(context.Background())
	defer cancelWorker()
	worker := &notifications.Worker{
		Pool:      pool,
		Sender:    &notifications.SMTPSender{URL: cfg.SMTPURL},
		MailFrom:  cfg.MailFrom,
		BatchSize: 10,
		PollEvery: 500 * time.Millisecond,
	}
	go worker.Run(workerCtx)

	srv := server.New(server.Config{
		ServiceName:      cfg.ServiceName,
		Implementation:   cfg.Implementation,
		CommitOpenAPIDir: cfg.CommitOpenAPIDir,
		Pool:             pool,
		Auth:             auth.NewService(pool),
		TrustedOrigins:   cfg.TrustedOrigins,
	})

	mux := http.NewServeMux()
	// The generated surface registers every documented domain path with
	// request validation; the stubs answer 501 in the shared taxonomy.
	mux.Handle("GET /api/docs", http.HandlerFunc(srv.DocsPage))
	mux.Handle("GET /api/docs-json", srv.ServeCommittedDoc("api.json"))
	mux.Handle("GET /api/docs-json/auth", srv.ServeCommittedDoc("auth.json"))
	srv.ExtraRoutes(mux)
	handler := server.RequestLog(gen.HandlerFromMux(srv, mux))

	httpServer := &http.Server{
		Addr:              ":" + strconv.Itoa(cfg.Port),
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	done := make(chan struct{})
	go func() {
		sig := make(chan os.Signal, 1)
		signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
		<-sig
		slog.Info("shutting down")
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := httpServer.Shutdown(shutdownCtx); err != nil {
			slog.Error("graceful shutdown failed", "err", err)
		}
		close(done)
	}()

	slog.Info("listening", "port", cfg.Port, "implementation", cfg.Implementation)
	if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		slog.Error("server failed", "err", err)
		os.Exit(1)
	}
	<-done
}
