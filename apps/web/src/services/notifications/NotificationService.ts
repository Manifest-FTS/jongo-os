import { db } from "@/lib/db";

type SecurityFindingSeverity = "INFO" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export interface NotificationPayload {
  title: string;
  message: string;
  severity: SecurityFindingSeverity;
  metadata?: Record<string, any>;
}

export interface NotificationProvider {
  send(payload: NotificationPayload, config: any): Promise<boolean>;
}

export class SlackProvider implements NotificationProvider {
  async send(payload: NotificationPayload, config: any): Promise<boolean> {
    if (!config?.webhookUrl) return false;
    
    let color = "#36a64f"; // default green
    if (payload.severity === "CRITICAL" || payload.severity === "HIGH") color = "#ff0000";
    if (payload.severity === "MEDIUM") color = "#ffcc00";

    const body = {
      attachments: [
        {
          color,
          title: payload.title,
          text: payload.message,
          fields: Object.entries(payload.metadata || {}).map(([key, value]) => ({
            title: key,
            value: JSON.stringify(value),
            short: true
          }))
        }
      ]
    };

    try {
      const response = await fetch(config.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}

export class EmailProvider implements NotificationProvider {
  async send(payload: NotificationPayload, config: any): Promise<boolean> {
    if (!config?.email) return false;
    // Mock email implementation for now
    console.log(`Sending email to ${config.email} about ${payload.title}`);
    return true;
  }
}

export class NotificationService {
  private providers: Record<string, NotificationProvider> = {
    slack: new SlackProvider(),
    email: new EmailProvider(),
  };

  async dispatchToOrganization(organizationId: string, payload: NotificationPayload): Promise<void> {
    const channels = await db.notificationChannel.findMany({
      where: { organizationId, enabled: true }
    });

    for (const channel of channels) {
      if (!this.meetsSeverityThreshold(payload.severity, channel.minimumSeverity)) {
        continue;
      }

      const provider = this.providers[channel.provider];
      if (provider) {
        await provider.send(payload, channel.config);
      }
    }
  }

  private meetsSeverityThreshold(payloadSeverity: SecurityFindingSeverity, minimumSeverity: SecurityFindingSeverity): boolean {
    const levels = {
      "INFO": 0,
      "LOW": 1,
      "MEDIUM": 2,
      "HIGH": 3,
      "CRITICAL": 4
    };
    return levels[payloadSeverity] >= levels[minimumSeverity];
  }
}
