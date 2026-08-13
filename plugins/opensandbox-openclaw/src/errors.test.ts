import { describe, expect, it } from "vitest";
import {
  SandboxApiException,
  SandboxError,
  SandboxException,
} from "@alibaba-group/opensandbox";
import { toReadableError } from "./errors.js";

describe("toReadableError", () => {
  it("maps a base SandboxException to a readable error with code and message", () => {
    const err = new SandboxException({
      message: "sandbox not found",
      error: new SandboxError("NOT_FOUND", "no such sandbox"),
      requestId: "req-123",
    });
    const out = toReadableError(err);
    expect(out).toBeInstanceOf(Error);
    expect(out.message).toContain("SandboxException");
    expect(out.message).toContain("[NOT_FOUND]");
    expect(out.message).toContain("[requestId=req-123]");
    expect(out.message).toContain("sandbox not found");
  });

  it("includes the HTTP status code for SandboxApiException", () => {
    const err = new SandboxApiException({
      message: "server rejected the request",
      statusCode: 400,
      error: new SandboxError("INVALID_ARGUMENT"),
    });
    const out = toReadableError(err);
    expect(out.message).toContain("SandboxApiException");
    expect(out.message).toContain("(status=400)");
    expect(out.message).toContain("[INVALID_ARGUMENT]");
  });

  it("passes plain Error instances through unchanged", () => {
    const err = new Error("boom");
    expect(toReadableError(err)).toBe(err);
  });

  it("stringifies unknown thrown values", () => {
    const out = toReadableError("some string");
    expect(out.message).toContain("some string");
  });
});
