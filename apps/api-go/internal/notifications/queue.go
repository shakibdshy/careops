// Package notifications implements the PostgreSQL-backed job queue for
// Notifications and Reminders (ADR-0017): enqueue happens in the SAME
// transaction as the domain change that causes it, processing is
// at-least-once with retries, and durable receipts (unique per Organization
// + kind + entity) guarantee at most one Notification per event.
package notifications

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/shakibdshy/careops/api-go/internal/store"
)

const (
	KindPatientCreated      = "patient.created"
	KindAppointmentBooked   = "appointment.booked"
	KindAppointmentReminder = "appointment.reminder"

	// ReminderLead is how long before an Appointment the Reminder fires.
	ReminderLead = 24 * time.Hour
)

type payload struct {
	OrganizationID string `json:"organizationId"`
	PatientID      string `json:"patientId"`
	AppointmentID  string `json:"appointmentId,omitempty"`
	Kind           string `json:"kind"`
}

func marshalPayload(p payload) []byte {
	raw, _ := json.Marshal(p)
	return raw
}

// EnqueuePatientCreated schedules the patient.created Notification inside
// the caller's transaction (same commit as the Patient row — ADR-0017).
func EnqueuePatientCreated(ctx context.Context, tx store.DBTX, organizationID, patientID string) error {
	return store.New(tx).EnqueueNotificationJob(ctx, store.EnqueueNotificationJobParams{
		Kind:    KindPatientCreated,
		Payload: marshalPayload(payload{OrganizationID: organizationID, PatientID: patientID, Kind: KindPatientCreated}),
	})
}

// EnqueueBooking schedules the booking confirmation and the Reminder (24h
// ahead of the start) in the booking's transaction.
func EnqueueBooking(ctx context.Context, tx store.DBTX, organizationID, appointmentID, patientID string, startsAt time.Time) error {
	return errors.Join(
		enqueueBooked(ctx, tx, organizationID, appointmentID, patientID),
		EnqueueReminder(ctx, tx, organizationID, appointmentID, patientID, startsAt),
	)
}

// enqueueBooked schedules the booking confirmation Notification.
func enqueueBooked(ctx context.Context, tx store.DBTX, organizationID, appointmentID, patientID string) error {
	return store.New(tx).EnqueueNotificationJob(ctx, store.EnqueueNotificationJobParams{
		Kind:    KindAppointmentBooked,
		Payload: marshalPayload(payload{OrganizationID: organizationID, PatientID: patientID, AppointmentID: appointmentID, Kind: KindAppointmentBooked}),
	})
}

// EnqueueReminder schedules the Reminder job 24h ahead of the start (due now
// if that moment already passed). Used by the booking path and by the demo
// seed, which schedules the same reminders the API would have.
func EnqueueReminder(ctx context.Context, tx store.DBTX, organizationID, appointmentID, patientID string, startsAt time.Time) error {
	return store.New(tx).EnqueueNotificationJob(ctx, store.EnqueueNotificationJobParams{
		Kind:    KindAppointmentReminder,
		Payload: marshalPayload(payload{OrganizationID: organizationID, PatientID: patientID, AppointmentID: appointmentID, Kind: KindAppointmentReminder}),
		RunAt:   pgtypeFromTime(startsAt.Add(-ReminderLead)),
	})
}

// WithdrawReminders deletes the pending Reminder jobs for an Appointment —
// called in the same transaction as a cancellation or a move (the reminder
// is withdrawn; a moved appointment gets a fresh reminder from its new
// start).
func WithdrawReminders(ctx context.Context, tx store.DBTX, appointmentID string) error {
	_, err := store.New(tx).WithdrawReminderJobs(ctx, []byte(`{"appointmentId":"`+appointmentID+`"}`))
	return err
}
