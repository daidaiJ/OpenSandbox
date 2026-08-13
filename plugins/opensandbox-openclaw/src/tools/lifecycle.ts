import { Type } from "typebox";
import type { Static } from "typebox";
import type { SandboxClient } from "../client.js";
import type { PluginConfig } from "../config.js";

export const networkRuleSchema = Type.Object(
  {
    action: Type.Union([Type.Literal("allow"), Type.Literal("deny")], {
      description: "Whether to allow or deny matching targets.",
    }),
    target: Type.String({
      description:
        'FQDN or wildcard domain, e.g. "example.com" or "*.example.com". IP/CIDR targets are not supported.',
    }),
  },
  { additionalProperties: false }
);

export const networkPolicySchema = Type.Object(
  {
    defaultAction: Type.Optional(
      Type.Union([Type.Literal("allow"), Type.Literal("deny")], {
        description:
          "Default action when no egress rule matches (server default: deny).",
      })
    ),
    egress: Type.Optional(
      Type.Array(networkRuleSchema, {
        description: "Outbound egress rules, evaluated in order.",
      })
    ),
  },
  { additionalProperties: false }
);

export const createSandboxParams = Type.Object({
  image: Type.Optional(
    Type.String({
      description:
        "Container image, e.g. python:3.11. Defaults to the plugin defaultImage config.",
    })
  ),
  timeoutSeconds: Type.Optional(
    Type.Number({
      description:
        "Server-side TTL in seconds; the sandbox and all its data are destroyed when it expires.",
    })
  ),
  env: Type.Optional(
    Type.Record(Type.String(), Type.String(), {
      description: "Environment variables injected into the sandbox.",
    })
  ),
  metadata: Type.Optional(
    Type.Record(Type.String(), Type.String(), {
      description: "Custom metadata tags for filtering/management.",
    })
  ),
  resource: Type.Optional(
    Type.Record(Type.String(), Type.String(), {
      description:
        "Resource limits for the container, e.g. {cpu: '1', memory: '2Gi'}.",
    })
  ),
  networkPolicy: Type.Optional(networkPolicySchema),
  entrypoint: Type.Optional(
    Type.Array(Type.String(), {
      description: "Entrypoint command; defaults to tail -f /dev/null.",
    })
  ),
});
export type CreateSandboxParams = Static<typeof createSandboxParams>;

export const connectSandboxParams = Type.Object({
  sandboxId: Type.String({
    description:
      "ID of an existing sandbox, e.g. from a previous sandbox_create call or from another process.",
  }),
});
export type ConnectSandboxParams = Static<typeof connectSandboxParams>;

export const listSandboxesParams = Type.Object({
  states: Type.Optional(
    Type.Array(Type.String(), {
      description: "Filter by lifecycle state, e.g. ['Running', 'Paused'].",
    })
  ),
  metadata: Type.Optional(
    Type.Record(Type.String(), Type.String(), {
      description: "Filter by exact metadata key-value pairs.",
    })
  ),
  page: Type.Optional(
    Type.Number({ description: "Pagination page (1-indexed)." })
  ),
  pageSize: Type.Optional(
    Type.Number({ description: "Items per page." })
  ),
});
export type ListSandboxesParams = Static<typeof listSandboxesParams>;

export const getSandboxInfoParams = Type.Object({
  sandboxId: Type.String({ description: "Target sandbox ID." }),
});
export type GetSandboxInfoParams = Static<typeof getSandboxInfoParams>;

export const renewSandboxParams = Type.Object({
  sandboxId: Type.String({ description: "Target sandbox ID." }),
  timeoutSeconds: Type.Number({
    description:
      "New TTL in seconds from now; the sandbox expires timeoutSeconds later.",
  }),
});
export type RenewSandboxParams = Static<typeof renewSandboxParams>;

export const killSandboxParams = Type.Object({
  sandboxId: Type.String({ description: "Target sandbox ID." }),
});
export type KillSandboxParams = Static<typeof killSandboxParams>;

export const getEndpointParams = Type.Object({
  sandboxId: Type.String({ description: "Target sandbox ID." }),
  port: Type.Number({
    description: "Port inside the sandbox to expose, e.g. 8080.",
  }),
});
export type GetEndpointParams = Static<typeof getEndpointParams>;

export async function execCreateSandbox(
  client: SandboxClient,
  _config: PluginConfig,
  params: CreateSandboxParams
): Promise<{
  sandboxId: string;
  state: string;
  createdAt: string;
  expiresAt: string | null;
}> {
  const sandbox = await client.create({
    image: params.image ?? client.config.defaultImage,
    timeoutSeconds: params.timeoutSeconds,
    env: params.env,
    metadata: params.metadata,
    resource: params.resource,
    networkPolicy: params.networkPolicy,
    entrypoint: params.entrypoint,
  });
  const info = await sandbox.getInfo();
  return {
    sandboxId: sandbox.id,
    state: info.status.state,
    createdAt: info.createdAt.toISOString(),
    expiresAt: info.expiresAt ? info.expiresAt.toISOString() : null,
  };
}

export async function execConnectSandbox(
  client: SandboxClient,
  _config: PluginConfig,
  params: ConnectSandboxParams
): Promise<{ sandboxId: string; state: string }> {
  const sandbox = await client.getSandbox(params.sandboxId);
  const info = await sandbox.getInfo();
  return { sandboxId: sandbox.id, state: info.status.state };
}

export async function execListSandboxes(
  client: SandboxClient,
  _config: PluginConfig,
  params: ListSandboxesParams
): Promise<{
  items: { id: string; state: string; createdAt: string }[];
  page: number;
  total: number;
}> {
  const res = await client.manager().listSandboxInfos({
    states: params.states,
    metadata: params.metadata,
    page: params.page,
    pageSize: params.pageSize,
  });
  return {
    items: res.items.map((i) => ({
      id: i.id,
      state: i.status.state,
      createdAt: i.createdAt.toISOString(),
    })),
    page: res.pagination?.page ?? 1,
    total: res.pagination?.totalItems ?? res.items.length,
  };
}

export async function execGetSandboxInfo(
  client: SandboxClient,
  _config: PluginConfig,
  params: GetSandboxInfoParams
): Promise<{
  sandboxId: string;
  state: string;
  statusReason: string | null;
  statusMessage: string | null;
  createdAt: string;
  expiresAt: string | null;
  metadata: Record<string, string>;
  image: string | null;
  entrypoint: string[];
}> {
  const sandbox = await client.getSandbox(params.sandboxId);
  const info = await sandbox.getInfo();
  return {
    sandboxId: info.id,
    state: info.status.state,
    statusReason: info.status.reason ?? null,
    statusMessage: info.status.message ?? null,
    createdAt: info.createdAt.toISOString(),
    expiresAt: info.expiresAt ? info.expiresAt.toISOString() : null,
    metadata: info.metadata ?? {},
    image: info.image?.uri ?? null,
    entrypoint: info.entrypoint,
  };
}

export async function execRenewSandbox(
  client: SandboxClient,
  _config: PluginConfig,
  params: RenewSandboxParams
): Promise<{ sandboxId: string; expiresAt: string | null }> {
  const sandbox = await client.getSandbox(params.sandboxId);
  const res = await sandbox.renew(params.timeoutSeconds);
  return {
    sandboxId: params.sandboxId,
    expiresAt: res.expiresAt ? res.expiresAt.toISOString() : null,
  };
}

export async function execKillSandbox(
  client: SandboxClient,
  _config: PluginConfig,
  params: KillSandboxParams
): Promise<{ sandboxId: string; state: "terminated" }> {
  const sandbox = await client.getSandbox(params.sandboxId);
  await sandbox.kill();
  await client.release(params.sandboxId);
  return { sandboxId: params.sandboxId, state: "terminated" };
}

export async function execGetEndpoint(
  client: SandboxClient,
  _config: PluginConfig,
  params: GetEndpointParams
): Promise<{ endpoint: string }> {
  const sandbox = await client.getSandbox(params.sandboxId);
  const endpoint = await sandbox.getEndpointUrl(params.port);
  return { endpoint };
}
