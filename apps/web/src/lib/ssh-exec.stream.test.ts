import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";

const spawnMock = vi.fn();
vi.mock("node:child_process", () => ({ spawn: (...args: unknown[]) => spawnMock(...args) }));

/** A stand-in for the ssh child: real streams, controllable exit. */
function makeChild() {
  const child = new EventEmitter() as any;
  child.stdout = new Readable({ read() {} });
  child.stderr = new Readable({ read() {} });
  child.stdin = { end: vi.fn(), on: vi.fn() };
  child.kill = vi.fn();
  child.exit = (code: number) => {
    child.stdout.push(null);
    child.emit("close", code);
  };
  return child;
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c)));
}

let streamHostScript: typeof import("./ssh-exec").streamHostScript;

beforeEach(async () => {
  vi.resetModules();
  spawnMock.mockReset();
  process.env.STAGING_SYNC_SSH_HOST = "backup-host.test";
  // A path, so no temp key file is written during the test.
  process.env.STAGING_SYNC_SSH_PRIVATE_KEY_PATH = "/dev/null";
  ({ streamHostScript } = await import("./ssh-exec"));
});

afterEach(() => {
  delete process.env.STAGING_SYNC_SSH_HOST;
  delete process.env.STAGING_SYNC_SSH_PRIVATE_KEY_PATH;
});

describe("streamHostScript", () => {
  it("reports failure, not a truncated archive, when the remote dies before any output", async () => {
    const child = makeChild();
    spawnMock.mockReturnValue(child);
    const pending = streamHostScript("dump");
    child.stderr.push(Buffer.from("Fatal: failed to find snapshot"));
    setImmediate(() => child.exit(1));

    const result = await pending;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.stderr).toMatch(/failed to find snapshot/);
  });

  it("streams every byte, including the chunk consumed to decide success", async () => {
    const child = makeChild();
    spawnMock.mockReturnValue(child);
    const pending = streamHostScript("dump");
    child.stdout.push(Buffer.from("first-"));

    const result = await pending;
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    setImmediate(() => {
      child.stdout.push(Buffer.from("second-"));
      child.stdout.push(Buffer.from("third"));
      child.exit(0);
    });

    expect((await collect(result.body)).toString()).toBe("first-second-third");
  });

  it("completes when the process exits before the stream is read (small archives)", async () => {
    const child = makeChild();
    spawnMock.mockReturnValue(child);
    const pending = streamHostScript("dump");
    // Both the output and the exit land BEFORE the stream object is built, so
    // a "close" listener attached inside start() would miss the exit entirely
    // and the download would hang forever waiting for an end that already came.
    child.stdout.push(Buffer.from("tiny"));
    child.exit(0);

    const result = await pending;
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect((await collect(result.body)).toString()).toBe("tiny");
  });

  it("errors the stream on a non-zero exit part-way, rather than ending cleanly", async () => {
    const child = makeChild();
    spawnMock.mockReturnValue(child);
    const pending = streamHostScript("dump");
    child.stdout.push(Buffer.from("partial"));

    const result = await pending;
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    setImmediate(() => child.exit(2));
    // A clean close here would hand the user a short file they would trust.
    await expect(collect(result.body)).rejects.toThrow(/exit 2/);
  });

  it("kills the remote when the client cancels, so Backblaze egress stops", async () => {
    const child = makeChild();
    spawnMock.mockReturnValue(child);
    const pending = streamHostScript("dump");
    child.stdout.push(Buffer.from("x"));

    const result = await pending;
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    await result.body.cancel();
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });
});
