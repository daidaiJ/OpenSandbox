import {
  SandboxApiException,
  SandboxException,
} from "@alibaba-group/opensandbox";

/**
 * Convert an SDK error into a model-readable Error with a stable error code.
 *
 * OpenClaw surfaces tool errors back to the agent, so keeping the SDK error
 * code and requestId in the message lets the model self-heal (e.g. retry
 * sandbox_create with a different image) and lets users correlate failures
 * with server-side logs.
 */
export function toReadableError(err: unknown): Error {
  if (err instanceof SandboxException) {
    const code = err.error?.code ?? "SANDBOX_ERROR";
    const status =
      err instanceof SandboxApiException && err.statusCode != null
        ? ` (status=${err.statusCode})`
        : "";
    const requestId = err.requestId ? ` [requestId=${err.requestId}]` : "";
    const detail = err.message ? `: ${err.message}` : "";
    return new Error(`OpenSandbox ${err.name} [${code}]${status}${requestId}${detail}`);
  }
  if (err instanceof Error) {
    return err;
  }
  return new Error(`OpenSandbox error: ${String(err)}`);
}

/** Run a tool executor and normalize any thrown error. */
export async function withErrorHandling<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw toReadableError(err);
  }
}
