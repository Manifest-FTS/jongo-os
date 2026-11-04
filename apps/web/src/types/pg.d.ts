// Minimal types for the parts of `pg` used by lib/live-events-listener.ts.
declare module "pg" {
  export class Client {
    constructor(config: { connectionString: string; application_name?: string });
    connect(): Promise<void>;
    query(text: string): Promise<unknown>;
    end(): Promise<void>;
    on(event: "notification", listener: (message: { channel: string; payload?: string }) => void): this;
    on(event: "error", listener: (error: Error) => void): this;
  }
}
