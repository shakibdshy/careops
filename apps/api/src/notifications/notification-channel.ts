/** One outgoing notification, resolved to a concrete recipient at consume time. */
export interface NotificationMessage {
  to: string;
  subject: string;
  text: string;
}

/**
 * The delivery seam (ticket #29). The processor depends on this interface, not
 * on SMTP, so e2e swaps in a recording fake and unit tests stub success/failure
 * without a network. The real implementation is nodemailer SMTP.
 */
export interface NotificationChannel {
  send(message: NotificationMessage): Promise<{ providerMessageId: string }>;
}

export const NOTIFICATION_CHANNEL = Symbol('NOTIFICATION_CHANNEL');
