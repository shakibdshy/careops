// The Go replica's entrypoint (Go-T05): config from the environment (fail
// fast), the generated contract surface wired onto a std net/http mux, JSON
// request logs, and graceful shutdown on SIGINT/SIGTERM.
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
	"github.com/shakibdshy/careops/api-go/internal/config"
	"github.com/shakibdshy/careops/api-go/internal/server"
)

func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, nil)))

	cfg, err := config.Load()
	if err != nil {
		slog.Error("invalid configuration", "err", err)
		os.Exit(1)
	}

	srv := server.New(server.Config{
		ServiceName:      cfg.ServiceName,
		Implementation:   cfg.Implementation,
		CommitOpenAPIDir: cfg.CommitOpenAPIDir,
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
