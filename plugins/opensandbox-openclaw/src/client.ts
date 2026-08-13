import {
  ConnectionConfig,
  Sandbox,
  SandboxManager,
} from "@alibaba-group/opensandbox";
import type { SandboxCreateOptions } from "@alibaba-group/opensandbox";
import type { PluginConfig } from "./config.js";

/**
 * Process-wide sandbox access facade.
 *
 * Connection strategy: one shared base {@link ConnectionConfig} per config
 * key. `Sandbox.create`/`Sandbox.connect`/`SandboxManager.create` each call
 * `withTransportIfMissing()`, which returns a clone with its own transport, so
 * sharing the base instance is safe and `close()` on one instance never
 * affects others.
 *
 * Sandbox instances are held in an LRU registry keyed by sandbox_id so tool
 * calls on the same sandbox reuse the existing connection. Registry eviction
 * only releases the local transport (`close()`); it never kills the remote
 * sandbox. Remote lifecycle is owned by the agent (create -> use -> kill);
 * anything left un-killed is reclaimed by the server-side TTL.
 */
export interface SandboxClient {
  readonly config: PluginConfig;

  /** Create a sandbox and register it in the local LRU registry. */
  create(options: SandboxCreateOptions): Promise<Sandbox>;
  /** Get a connected Sandbox for the id, reconnecting on cache miss. */
  getSandbox(sandboxId: string): Promise<Sandbox>;
  /** Remember a freshly connected Sandbox in the local LRU registry. */
  register(sandbox: Sandbox): void;
  /** Drop a Sandbox from the registry and release its local transport (does NOT kill the remote sandbox). */
  release(sandboxId: string): Promise<void>;
  /** Administrative manager for list/get/renew without a Sandbox instance. */
  manager(): SandboxManager;
}

class SandboxClientImpl implements SandboxClient {
  readonly config: PluginConfig;
  private readonly connection: ConnectionConfig;
  private readonly registry = new Map<string, Sandbox>();
  private managerInstance: SandboxManager | null = null;

  constructor(config: PluginConfig) {
    this.config = config;
    this.connection = new ConnectionConfig({
      domain: config.domain,
      protocol: config.protocol,
      apiKey: config.apiKey,
      requestTimeoutSeconds: config.requestTimeoutSeconds,
      useServerProxy: config.useServerProxy,
    });
  }

  async create(options: SandboxCreateOptions): Promise<Sandbox> {
    const sandbox = await Sandbox.create({
      connectionConfig: this.connection,
      ...options,
    });
    this.register(sandbox);
    return sandbox;
  }

  async getSandbox(sandboxId: string): Promise<Sandbox> {
    const hit = this.registry.get(sandboxId);
    if (hit) {
      // Refresh LRU recency.
      this.registry.delete(sandboxId);
      this.registry.set(sandboxId, hit);
      return hit;
    }
    const sandbox = await Sandbox.connect({
      sandboxId,
      connectionConfig: this.connection,
    });
    this.register(sandbox);
    return sandbox;
  }

  register(sandbox: Sandbox): void {
    const existing = this.registry.get(sandbox.id);
    if (existing && existing !== sandbox) {
      void existing.close().catch(() => undefined);
    }
    this.registry.delete(sandbox.id);
    this.registry.set(sandbox.id, sandbox);
    this.evict();
  }

  async release(sandboxId: string): Promise<void> {
    const sandbox = this.registry.get(sandboxId);
    this.registry.delete(sandboxId);
    if (sandbox) {
      await sandbox.close().catch(() => undefined);
    }
  }

  manager(): SandboxManager {
    this.managerInstance ??= SandboxManager.create({
      connectionConfig: this.connection,
    });
    return this.managerInstance;
  }

  private evict(): void {
    while (this.registry.size > this.config.sandboxCacheSize) {
      const oldestId = this.registry.keys().next().value;
      if (oldestId == null) break;
      const oldest = this.registry.get(oldestId);
      this.registry.delete(oldestId);
      if (oldest) {
        void oldest.close().catch(() => undefined);
      }
    }
  }
}

const clientCache = new Map<string, SandboxClient>();

/**
 * Get (and cache) the client for a normalized config.
 *
 * Caching is keyed by everything that affects the connection, so different
 * plugins/agents with different credentials do not share a client while
 * repeated tool calls reuse the keep-alive pool.
 */
export function getSandboxClient(config: PluginConfig): SandboxClient {
  const key = [
    config.domain,
    config.protocol,
    config.apiKey ?? "",
    config.useServerProxy,
    config.requestTimeoutSeconds,
  ].join("|");
  let client = clientCache.get(key);
  if (!client) {
    client = new SandboxClientImpl(config);
    clientCache.set(key, client);
  }
  return client;
}
