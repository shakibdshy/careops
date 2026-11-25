package notifications

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"net/smtp"
	"net/url"
	"strings"
)

// SMTPSender delivers over SMTP (Mailpit locally, a real relay in prod).
type SMTPSender struct {
	URL string
}

func (s *SMTPSender) Send(ctx context.Context, from, to, subject, body string) (string, error) {
	endpoint, err := url.Parse(s.URL)
	if err != nil {
		return "", fmt.Errorf("smtp url: %w", err)
	}
	addr := endpoint.Host
	if addr == "" {
		return "", fmt.Errorf("smtp url: missing host")
	}

	id := newMessageID()
	msg := strings.Join([]string{
		"From: " + from,
		"To: " + to,
		"Subject: " + subject,
		"Message-ID: <" + id + "@careops.local>",
		"MIME-Version: 1.0",
		"Content-Type: text/plain; charset=utf-8",
		"",
		body,
	}, "\r\n") + "\r\n"

	host := hostOf(addr)
	err = smtp.SendMail(addr, nil, envelopeFrom(from), []string{to}, []byte(msg))
	if err != nil {
		return "", fmt.Errorf("smtp send via %s (%s): %w", addr, host, err)
	}
	return id, nil
}

// envelopeFrom extracts the bare address from a 'Name <addr>' header value
// — the SMTP envelope (MAIL FROM) must not carry a display name.
func envelopeFrom(headerFrom string) string {
	if start := strings.IndexByte(headerFrom, '<'); start >= 0 {
		if end := strings.IndexByte(headerFrom[start:], '>'); end > 0 {
			return headerFrom[start+1 : start+end]
		}
	}
	return headerFrom
}

func hostOf(addr string) string {
	if idx := strings.LastIndex(addr, ":"); idx > 0 {
		return addr[:idx]
	}
	return addr
}

func newMessageID() string {
	raw := make([]byte, 12)
	if _, err := rand.Read(raw); err != nil {
		return "careops-local"
	}
	return hex.EncodeToString(raw)
}
