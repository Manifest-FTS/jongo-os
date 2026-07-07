import { db } from "@/lib/db";
import { NotificationService } from "../notifications/NotificationService";
import { SecurityFindingSeverity } from "@prisma/client";

export interface ScanReportPayload {
  resourceId: string;
  resourceType: string;
  jobId?: string;
  environment: string;
  scanner: string;
  scannerMeta?: Record<string, any>;
  scanType: string; // 'malware' or 'integrity'
  startTime: string;
  endTime: string;
  filesScanned: number;
  findings: Array<{
    path: string;
    signature: string;
    severity: SecurityFindingSeverity;
    actionTaken: string;
  }>;
  status: "COMPLETED" | "FAILED";
  errorDetails?: string;
  timestamp: number;
}

export class SecurityService {
  private notificationService: NotificationService;

  constructor() {
    this.notificationService = new NotificationService();
  }

  async processScanReport(payload: ScanReportPayload): Promise<void> {
    // 1. Persist the scan result
    const scanResult = await db.securityScanResult.create({
      data: {
        resourceId: payload.resourceId,
        resourceType: payload.resourceType,
        jobId: payload.jobId,
        environment: payload.environment,
        scanner: payload.scanner,
        scannerMeta: payload.scannerMeta || {},
        scanType: payload.scanType,
        startTime: new Date(payload.startTime),
        endTime: new Date(payload.endTime),
        durationMs: new Date(payload.endTime).getTime() - new Date(payload.startTime).getTime(),
        filesScanned: payload.filesScanned,
        findings: payload.findings,
        status: payload.status,
        errorDetails: payload.errorDetails
      }
    });

    // 2. Determine highest severity
    if (payload.findings.length > 0) {
      let highestSeverity: SecurityFindingSeverity = "INFO";
      const levels: Record<SecurityFindingSeverity, number> = {
        "INFO": 0, "LOW": 1, "MEDIUM": 2, "HIGH": 3, "CRITICAL": 4
      };

      for (const finding of payload.findings) {
        if (levels[finding.severity] > levels[highestSeverity]) {
          highestSeverity = finding.severity;
        }
      }

      // 3. Resolve Organization for Notifications
      // Assuming resourceId is a Site UUID for now to find the organization
      let organizationId = null;
      if (payload.resourceType === "site") {
        const site = await db.site.findUnique({
          where: { id: payload.resourceId },
          select: { organizationId: true }
        });
        organizationId = site?.organizationId;
      }
      
      // 4. Dispatch Notifications
      if (organizationId) {
        await this.notificationService.dispatchToOrganization(organizationId, {
          title: `Security Alert: ${payload.findings.length} findings in ${payload.environment} environment`,
          message: `Scanner ${payload.scanner} detected security issues.`,
          severity: highestSeverity,
          metadata: {
            resourceId: payload.resourceId,
            scanId: scanResult.id,
            topFinding: payload.findings[0]?.signature || "Unknown"
          }
        });
      }
    }
  }
}
