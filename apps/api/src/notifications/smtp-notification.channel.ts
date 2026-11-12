import { Injectable } from '@nestjs/common';
import { createTransport } from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { loadConfig } from '../config/env.js';
import type { NotificationChannel, NotificationMessage } from './notification-channel.js';

/**
 * Real delivery (ticket #29): nodemailer over SMTP. The transporter is created
 * from SMTP_URL but connects lazily on first send, so boot never blocks on the
 * mail server being up. In the self-contained stack SMTP_URL points at Mailpit.
 */
@Injectable()
export class SmtpNotificationChannel implements NotificationChannel {
  private readonly transporter: Transporter;
  private readonly from: string;

  constructor() {
    const config = loadConfig();
    this.transporter = createTransport(config.smtpUrl);
    this.from = config.mailFrom;
  }

  async send(message: NotificationMessage): Promise<{ providerMessageId: string }> {
    const info = await this.transporter.sendMail({
      from: this.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
    });
    return { providerMessageId: info.messageId };
  }
}
