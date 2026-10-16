/** Organization bookkeeping only. Never reads or mutates per-User Stripe subscriptions. */
export const BILLING_MODES = ["manual_override", "bonsai", "native_stripe", "exempt"] as const;
export const BILLING_STATUSES = ["active_paid", "past_due", "pending_setup", "comped"] as const;
export type BillingMode = typeof BILLING_MODES[number];
export type BillingStatus = typeof BILLING_STATUSES[number];
export type BillingClient = {
  id: string;
  name: string;
  billingMode: BillingMode;
  billingStatus: BillingStatus;
  billingNotes: string | null;
  bonsaiClientId: string | null;
  externalInvoiceUrl: string | null;
};
export type ClientDriverStatus = {
  billingStatus: BillingStatus | null;
  source: BillingMode;
  supported: boolean;
  message: string;
};
export type ClientSyncResult = ClientDriverStatus & { mutated: false };

export interface BillingDriverInterface {
  getClientStatus(client: BillingClient): Promise<ClientDriverStatus>;
  syncClient(client: BillingClient): Promise<ClientSyncResult>;
}

export class ManualBillingDriver implements BillingDriverInterface {
  async getClientStatus(client: BillingClient): Promise<ClientDriverStatus> {
    if (!BILLING_STATUSES.includes(client.billingStatus)) throw new Error("Invalid persisted billing status.");
    return { billingStatus: client.billingStatus, source: "manual_override", supported: true, message: "Operator-maintained persisted status; no payment verification is performed." };
  }
  async syncClient(client: BillingClient): Promise<ClientSyncResult> {
    return { ...await this.getClientStatus(client), mutated: false };
  }
}

/** Deliberate non-mutating skeletons: no SDK, credentials, fetch, or fallback. */
export class BonsaiBillingDriver implements BillingDriverInterface {
  async getClientStatus(_client: BillingClient): Promise<ClientDriverStatus> {
    return { billingStatus: null, source: "bonsai", supported: false, message: "Bonsai synchronization is unsupported; payment status is unknown." };
  }
  async syncClient(client: BillingClient): Promise<ClientSyncResult> {
    return { ...await this.getClientStatus(client), mutated: false };
  }
}

export class NativeStripeBillingDriver implements BillingDriverInterface {
  async getClientStatus(_client: BillingClient): Promise<ClientDriverStatus> {
    return { billingStatus: null, source: "native_stripe", supported: false, message: "Client Stripe synchronization is unsupported; account subscriptions are separate." };
  }
  async syncClient(client: BillingClient): Promise<ClientSyncResult> {
    return { ...await this.getClientStatus(client), mutated: false };
  }
}

export class ExemptBillingDriver implements BillingDriverInterface {
  async getClientStatus(_client: BillingClient): Promise<ClientDriverStatus> {
    return { billingStatus: "comped", source: "exempt", supported: true, message: "Comped is derived from exempt mode, not a payment or a stored status update." };
  }
  async syncClient(client: BillingClient): Promise<ClientSyncResult> {
    return { ...await this.getClientStatus(client), mutated: false };
  }
}

export function getBillingDriver(mode: BillingMode): BillingDriverInterface {
  switch (mode) {
    case "manual_override": return new ManualBillingDriver();
    case "bonsai": return new BonsaiBillingDriver();
    case "native_stripe": return new NativeStripeBillingDriver();
    case "exempt": return new ExemptBillingDriver();
    default: {
      const unsupported: never = mode;
      throw new Error(`Unsupported billing mode: ${unsupported}`);
    }
  }
}