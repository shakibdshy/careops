// Reports domain handlers (Go-T13): the four reports computed in SQL over
// the org-scoped plane, cached aside in Redis with the generation-counter
// invalidation strategy of ADR-0011 — every Appointment write advances the
// org's counter, cache keys embed it, so the next read recomputes (O(1)
// invalidation, zero key scans). The Go cache keys live under
// reports-go:{org}:{generation} — the reference's namespace is untouched.
package server

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/shakibdshy/careops/api-go/gen"

	"github.com/shakibdshy/careops/api-go/internal/db"
	"github.com/shakibdshy/careops/api-go/internal/store"
)

const (
	defaultReportDays = 30
	minReportDays     = 1
	maxReportDays     = 90
	capacityMinutes   = 8 * 60 // the documented 8h/day capacity constant
	cacheTTL          = 5 * time.Minute
)

// reportWindow parses and validates the bounded `days` query parameter,
// returning field-named taxonomy errors exactly like the reference.
func reportWindow(w http.ResponseWriter, r *http.Request) (int, bool) {
	raw := r.URL.Query().Get("days")
	if raw == "" {
		return defaultReportDays, true
	}
	days, err := strconv.Atoi(raw)
	if err != nil || days < minReportDays || days > maxReportDays {
		writeFieldErrors(w, []map[string]string{
			{"field": "days", "message": fmt.Sprintf("must be an integer between %d and %d", minReportDays, maxReportDays)},
		})
		return 0, false
	}
	return days, true
}

// cachedReport serves the report JSON from Redis when the generation still
// matches, and recomputes + repopulates otherwise. Redis is a boundary:
// every failure degrades to a fresh compute (ADR-0011).
func (s *Server) cachedReport(
	w http.ResponseWriter,
	r *http.Request,
	key string,
	recompute func(context.Context) (any, error),
) {
	ctx := r.Context()
	if s.rdb != nil {
		if cached, err := s.rdb.Get(ctx, key).Result(); err == nil {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(cached))
			return
		}
	}

	report, err := recompute(ctx)
	if err != nil {
		writeTaxonomy(w, http.StatusInternalServerError, "failed to compute report")
		return
	}
	raw, _ := json.Marshal(report)

	if s.rdb != nil {
		if err := s.rdb.Set(ctx, key, raw, cacheTTL).Err(); err != nil {
			slog.Warn("reports: cache write failed", "err", err)
		}
	}
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write(raw)
}

// reportKey composes the cache key under the Go service's own namespace,
// embedding the org's CURRENT cache generation — read from the Postgres
// counter (its source of truth; the appointment-write transactions bump it
// atomically), so a committed write is never masked by a stale key.
func (s *Server) reportKey(ctx context.Context, org OrgContext, report string, days int) string {
	generation, err := store.New(s.cfg.Pool).GetReportGeneration(ctx, uuidParam(org.OrganizationID))
	if err != nil {
		generation = 0
	}
	return cacheKey(org.OrganizationID, fmt.Sprintf("%d", generation), report, days)
}

func cacheKey(organizationID, generation, report string, days int) string {
	return fmt.Sprintf("reports-go:%s:%s:%s:%d", organizationID, generation, report, days)
}

// --- generated interface methods ---------------------------------------------

func (s *Server) ReportsControllerDailyVolume(w http.ResponseWriter, r *http.Request, params gen.ReportsControllerDailyVolumeParams) {
	org, failure := s.resolve(r)
	if failure != nil {
		failure.write(w)
		return
	}
	days, ok := reportWindow(w, r)
	if !ok {
		return
	}
	ctx := r.Context()
	key := s.reportKey(ctx, org, "daily-volume", days)
	s.cachedReport(w, r, key, func(ctx context.Context) (any, error) {
		var rows []store.DailyVolumeRow
		err := db.OrgTx(ctx, s.cfg.Pool, org.OrganizationID, func(tx pgx.Tx) error {
			var qErr error
			rows, qErr = store.New(tx).DailyVolume(ctx, store.DailyVolumeParams{OrganizationID: uuidParam(org.OrganizationID), Column2: int32(days)})
			return qErr
		})
		if err != nil {
			return nil, err
		}
		points := make([]map[string]any, 0, len(rows))
		for _, row := range rows {
			points = append(points, map[string]any{"date": row.Date, "count": row.Count})
		}
		return map[string]any{"days": days, "points": points}, nil
	})
}

func (s *Server) ReportsControllerStatusBreakdown(w http.ResponseWriter, r *http.Request, params gen.ReportsControllerStatusBreakdownParams) {
	org, failure := s.resolve(r)
	if failure != nil {
		failure.write(w)
		return
	}
	days, ok := reportWindow(w, r)
	if !ok {
		return
	}
	ctx := r.Context()
	key := s.reportKey(ctx, org, "status-breakdown", days)
	s.cachedReport(w, r, key, func(ctx context.Context) (any, error) {
		var statuses map[string]int
		err := db.OrgTx(ctx, s.cfg.Pool, org.OrganizationID, func(tx pgx.Tx) error {
			rows, err := store.New(tx).StatusBreakdown(ctx, store.StatusBreakdownParams{
				OrganizationID: uuidParam(org.OrganizationID),
				Column2:        int32(days),
			})
			if err != nil {
				return err
			}
			statuses = map[string]int{}
			for _, row := range rows {
				statuses[row.Status] = int(row.Count)
			}
			return nil
		})
		if err != nil {
			return nil, err
		}
		all := []string{"SCHEDULED", "CONFIRMED", "CHECKED_IN", "IN_PROGRESS", "COMPLETED", "CANCELLED", "NO_SHOW"}
		counts := make([]map[string]any, 0, len(all))
		total := 0
		for _, status := range all {
			count := statuses[status]
			counts = append(counts, map[string]any{"status": status, "count": count})
			total += count
		}
		cancellationRate := 0.0
		noShowRate := 0.0
		if total > 0 {
			cancellationRate = float64(statuses["CANCELLED"]) / float64(total)
			noShowRate = float64(statuses["NO_SHOW"]) / float64(total)
		}
		return map[string]any{
			"days":             days,
			"total":            total,
			"counts":           counts,
			"cancellationRate": cancellationRate,
			"noShowRate":       noShowRate,
		}, nil
	})
}

func (s *Server) ReportsControllerProviderUtilization(w http.ResponseWriter, r *http.Request, params gen.ReportsControllerProviderUtilizationParams) {
	org, failure := s.resolve(r)
	if failure != nil {
		failure.write(w)
		return
	}
	days, ok := reportWindow(w, r)
	if !ok {
		return
	}
	ctx := r.Context()
	key := s.reportKey(ctx, org, "provider-utilization", days)
	s.cachedReport(w, r, key, func(ctx context.Context) (any, error) {
		var rows []store.ProviderUtilizationRow
		err := db.OrgTx(ctx, s.cfg.Pool, org.OrganizationID, func(tx pgx.Tx) error {
			var err error
			rows, err = store.New(tx).ProviderUtilization(ctx, store.ProviderUtilizationParams{
				OrganizationID: uuidParam(org.OrganizationID),
				Column2:        int32(days),
			})
			return err
		})
		if err != nil {
			return nil, err
		}
		providers := make([]map[string]any, 0, len(rows))
		for _, row := range rows {
			providers = append(providers, map[string]any{
				"memberId":         row.MemberID,
				"providerName":     row.ProviderName,
				"bookedMinutes":    row.BookedMinutes,
				"appointmentCount": row.AppointmentCount,
				"utilization":      float64(row.BookedMinutes) / float64(capacityMinutes),
			})
		}
		return map[string]any{
			"days":                  days,
			"capacityMinutesPerDay": capacityMinutes,
			"providers":             providers,
		}, nil
	})
}

// ReportsControllerToday implements GET /api/reports/today: a plain indexed
// range query for the UTC calendar day — never an aggregation, never cached
// (the most latency-sensitive "what is happening now" view is never stale).
func (s *Server) ReportsControllerToday(w http.ResponseWriter, r *http.Request) {
	org, failure := s.resolve(r)
	if failure != nil {
		failure.write(w)
		return
	}
	ctx := r.Context()
	now := time.Now().UTC()
	midnight := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)

	var rows []store.Appointment
	err := db.OrgTx(ctx, s.cfg.Pool, org.OrganizationID, func(tx pgx.Tx) error {
		var err error
		rows, err = store.New(tx).TodaysAppointments(ctx, store.TodaysAppointmentsParams{
			OrganizationID: uuidParam(org.OrganizationID),
			Column2:        pgtype.Timestamptz{Time: midnight, Valid: true},
		})
		return err
	})
	if err != nil {
		writeTaxonomy(w, http.StatusInternalServerError, "failed to compute today's schedule")
		return
	}
	items := make([]Appointment, 0, len(rows))
	for _, row := range rows {
		items = append(items, appointmentView(row))
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"date":  midnight.Format("2006-01-02"),
		"items": items,
	})
}

// bumpGeneration advances the org's cache generation inside the Appointment
// write's transaction — invalidation is atomic with the mutation (stronger
// than the reference's post-commit bump: a crash cannot leave a stale
// generation).
func bumpGeneration(ctx context.Context, tx pgx.Tx, organizationID string) {
	_, _ = store.New(tx).BumpReportGeneration(ctx, uuidParam(organizationID))
}
