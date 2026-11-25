// Request logging: one structured JSON line per request on slog, with a
// request id that clients can echo back via X-Request-Id (generated as a
// 16-hex-char id otherwise — the same shape the reference's interceptors log).
package server

import (
	"crypto/rand"
	"encoding/hex"
	"log/slog"
	"net/http"
	"time"
)

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (r *statusRecorder) WriteHeader(status int) {
	r.status = status
	r.ResponseWriter.WriteHeader(status)
}

const requestIDHeader = "X-Request-Id"

func newRequestID() string {
	var buf [8]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return time.Now().UTC().Format("20060102T150405.000000000")
	}
	return hex.EncodeToString(buf[:])
}

// RequestLog returns middleware that logs one line per request and stamps the
// request id onto both the response header and the request context logger.
func RequestLog(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		id := r.Header.Get(requestIDHeader)
		if id == "" {
			id = newRequestID()
		}
		w.Header().Set(requestIDHeader, id)
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(rec, r)
		slog.InfoContext(r.Context(), "request",
			"requestId", id,
			"method", r.Method,
			"path", r.URL.Path,
			"status", rec.status,
			"durationMs", float64(time.Since(start).Microseconds())/1000,
		)
	})
}
