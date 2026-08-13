import { Type } from "typebox";
import type { Static } from "typebox";

/**
 * Plugin configuration schema, validated by OpenClaw against this shape.
 *
 * Runtime defaults are applied in {@link normalizeConfig}: TypeBox schema
 * `default` values are declarative metadata; OpenClaw does not guarantee to
 * fill them in before handing `config` to tool execute handlers.
 */
export const configSchema = Type.Object({
  apiKey: Type.Optional(
    Type.String({
      description:
        "OpenSandbox API key. Prefer the OPEN_SANDBOX_API_KEY environment variable or an OpenClaw SecretRef over hardcoding.",
    })
  ),
  domain: Type.Optional(
    Type.String({
      description:
        "OpenSandbox lifecycle server domain (host[:port]) without scheme, e.g. api.opensandbox.io.",
      default: "localhost:8080",
    })
  ),
  protocol: Type.Optional(
    Type.Union([Type.Literal("http"), Type.Literal("https")], {
      description: "Protocol used to reach the lifecycle server.",
      default: "http",
    })
  ),
  requestTimeoutSeconds: Type.Optional(
    Type.Number({
      description: "Timeout in seconds applied to SDK HTTP requests.",
      default: 30,
    })
  ),
  useServerProxy: Type.Optional(
    Type.Boolean({
      description:
        "Route execd/file/endpoint traffic through the lifecycle server proxy. Keep enabled when the OpenClaw gateway cannot reach sandbox public endpoints directly (default deployment topology); disable only when sandbox endpoints are reachable from the plugin process.",
      default: true,
    })
  ),
  defaultImage: Type.Optional(
    Type.String({
      description:
        "Container image used by sandbox_create when no image is provided.",
      default: "ubuntu",
    })
  ),
  maxOutputBytes: Type.Optional(
    Type.Number({
      description:
        "Maximum bytes of command output or file content returned to the agent; longer output is truncated.",
      default: 65536,
    })
  ),
  sandboxCacheSize: Type.Optional(
    Type.Number({
      description:
        "Upper bound of the in-process Sandbox instance LRU cache.",
      default: 8,
    })
  ),
}, {
  additionalProperties: false,
});

export type ConfigInput = Static<typeof configSchema>;

/** Fully-resolved plugin configuration with defaults applied. */
export interface PluginConfig {
  apiKey?: string;
  domain: string;
  protocol: "http" | "https";
  requestTimeoutSeconds: number;
  useServerProxy: boolean;
  defaultImage: string;
  maxOutputBytes: number;
  sandboxCacheSize: number;
}

export function normalizeConfig(config: ConfigInput): PluginConfig {
  return {
    apiKey: config.apiKey || undefined,
    domain: config.domain ?? "localhost:8080",
    protocol: config.protocol ?? "http",
    requestTimeoutSeconds: config.requestTimeoutSeconds ?? 30,
    useServerProxy: config.useServerProxy ?? true,
    defaultImage: config.defaultImage ?? "ubuntu",
    maxOutputBytes: config.maxOutputBytes ?? 64 * 1024,
    sandboxCacheSize: config.sandboxCacheSize ?? 8,
  };
}
