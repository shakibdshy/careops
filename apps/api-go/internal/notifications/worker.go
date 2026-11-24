package notifications

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/shakibdshy/careops/api-go/internal/auth"
	"github.com/shakibdshy/careops/api-go/internal/db"
	"github.com/shakibdshy/careops/api-go/internal/store"
)

func pgtypeFromTime(t time.Time) pgtype.Timestamptz {
	return pgtype.Timestamptz{Time: t, Valid: true}
}

// Sender delivers one notification over SMTP and reports the provider's
// message id (recorded on the receipt).
type Sender interface {
	Send(ctx context.Context, from, to, subject, body string) (string, error)
}

// Worker claims due jobs and processes them. Safe to run on several
// replicas: the claim query is FOR UPDATE SKIP LOCKED, and the receipt's
// unique index collapses any duplicate delivery to a no-op.
type Worker struct {
	Pool      *pgxpool.Pool
	Sender    Sender
	MailFrom  string
	BatchSize int32
	PollEvery time.Duration
}

func (w *Worker) queries() *store.Queries { return store.New(w.Pool) }

// Run polls until ctx is cancelled.
func (w *Worker) Run(ctx context.Context) {
	ticker := time.NewTicker(w.PollEvery)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			w.drainOnce(ctx)
		}
	}
}

func (w *Worker) drainOnce(ctx context.Context) {
	// The janitor first: jobs abandoned by a crashed replica go back to
	// pending before the claim pass.
	if _, err := w.queries().RequeueStuckJobs(ctx); err != nil {
		slog.Warn("notification janitor failed", "err", err)
	}

	jobs, err := w.queries().ClaimDueJobs(ctx, w.BatchSize)
	if err != nil {
		slog.Warn("notification poll failed", "err", err)
		return
	}
	for _, job := range jobs {
		if err := w.process(ctx, job); err != nil {
			slog.Warn("notification processing failed", "jobId", job.ID, "err", err)
			// At-least-once: a failed attempt goes back to pending with a
			// short backoff; the receipt's unique index keeps redelivery
			// from double-sending.
			if err := w.queries().RequeueJob(ctx, store.RequeueJobParams{
				ID:             job.ID,
				BackoffSeconds: pgtype.Float8{Float64: float64(5 * job.Attempts), Valid: true},
				LastError:      pgtype.Text{String: err.Error(), Valid: true},
			}); err != nil {
				slog.Warn("notification requeue failed", "jobId", job.ID, "err", err)
			}
		}
	}
}

// process delivers one job inside the payload's Organization scope (RLS
// governs the receipt write and the patient read exactly as it governs
// domain traffic) and records the outcome on the durable receipt: SENT with
// recipient + provider id, SKIPPED when the Patient has no Contact Email —
// never a silent drop. A transport failure is a recorded FAILED outcome,
// not a retry loop (the reference's same semantics).
func (w *Worker) process(ctx context.Context, job store.ClaimDueJobsRow) error {
	var p payload
	if err := json.Unmarshal(job.Payload, &p); err != nil {
		return fmt.Errorf("payload: %w", err)
	}
	entityID := auth.UUIDParam(p.AppointmentID)
	if !entityID.Valid {
		entityID = auth.UUIDParam(p.PatientID)
	}

	// Dedup boundary: a duplicate event leaves the original receipt intact.
	return db.OrgTx(ctx, w.Pool, p.OrganizationID, func(tx pgx.Tx) error {
		queries := store.New(tx)
		receiptID, err := queries.InsertReceiptIfNew(ctx, store.InsertReceiptIfNewParams{
			OrganizationID: auth.UUIDParam(p.OrganizationID),
			Kind:           p.Kind,
			EntityID:       entityID,
			Status:         "PENDING",
		})
		if err != nil {
			return err
		}
		if !receiptID.Valid {
			// Dedup hit: another replica already owns this event. The job is
			// done — its delivery would double-send.
			return queries.CompleteJob(ctx, job.ID)
		}

		recipient, err := queries.PatientContactEmail(ctx, auth.UUIDParam(p.PatientID))
		if err != nil {
			return err
		}
		if !recipient.Valid || recipient.String == "" {
			return finishReceipt(ctx, queries, receiptID, "SKIPPED", "", "")
		}

		subject, body := messageFor(p.Kind, p.AppointmentID)
		messageID, err := w.Sender.Send(ctx, w.MailFrom, recipient.String, subject, body)
		if err != nil {
			slog.Warn("notification delivery failed", "kind", p.Kind, "err", err)
			return finishReceipt(ctx, queries, receiptID, "FAILED", recipient.String, "")
		}
		if err := finishReceipt(ctx, queries, receiptID, "SENT", recipient.String, messageID); err != nil {
			return err
		}
		return queries.CompleteJob(ctx, job.ID)
	})
}

func finishReceipt(ctx context.Context, queries *store.Queries, id pgtype.UUID, status, recipient, providerID string) error {
	return queries.UpdateReceiptOutcome(ctx, store.UpdateReceiptOutcomeParams{
		ID:                id,
		Status:            status,
		Recipient:         pgtype.Text{String: recipient, Valid: recipient != ""},
		ProviderMessageID: pgtype.Text{String: providerID, Valid: providerID != ""},
	})
}

func messageFor(kind, appointmentID string) (string, string) {
	switch kind {
	case KindPatientCreated:
		return "Your CareOps record was created",
			"Hello, your care record has been created in CareOps."
	case KindAppointmentBooked:
		return "Your appointment is booked",
			"Hello, your appointment has been booked in CareOps."
	default:
		return "Appointment reminder",
			fmt.Sprintf("Hello, this is a reminder for your appointment (id %s).", appointmentID)
	}
}
