import type {
  NotificationChannel,
  NotificationMessage,
} from '../src/notifications/notification-channel.js';

/**
 * Recording delivery seam for e2e (ticket #29). Captures every message instead
 * of touching SMTP and returns a deterministic providerMessageId, so a booking
 * can assert a SENT receipt with a provider id without a network. setupE2eApp
 * injects it through the NOTIFICATION_CHANNEL override by default.
 */
export class RecordingNotificationChannel implements NotificationChannel {
  readonly sent: NotificationMessage[] = [];

  send(message: NotificationMessage): Promise<{ providerMessageId: string }> {
    this.sent.push(message);
    return Promise.resolve({ providerMessageId: `fake-message-${this.sent.length}` });
  }
}
