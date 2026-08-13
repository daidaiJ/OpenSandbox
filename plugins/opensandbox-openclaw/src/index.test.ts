import { describe, expect, it } from "vitest";
import { getToolPluginMetadata } from "openclaw/plugin-sdk/tool-plugin";
import plugin from "./index.js";

const metadata = getToolPluginMetadata(plugin);

describe("opensandbox-openclaw plugin metadata contract", () => {
  it("exposes plugin metadata", () => {
    expect(metadata).toBeDefined();
    expect(metadata!.id).toBe("opensandbox-openclaw");
    expect(metadata!.name).toBe("OpenSandbox Sandbox");
    expect(metadata!.description.length).toBeGreaterThan(0);
    expect(metadata!.activation?.onStartup).toBe(true);
  });

  it("declares exactly the 13 phase-1 tools in order", () => {
    const names = metadata!.tools.map((t) => t.name);
    expect(names).toEqual([
      "sandbox_create",
      "sandbox_connect",
      "sandbox_list",
      "sandbox_get_info",
      "sandbox_renew",
      "sandbox_kill",
      "sandbox_get_endpoint",
      "sandbox_run_command",
      "sandbox_interrupt_command",
      "sandbox_read_file",
      "sandbox_write_file",
      "sandbox_list_files",
      "sandbox_delete_files",
    ]);
  });

  it("keeps the config schema closed with the documented keys", () => {
    const schema = metadata!.configSchema;
    expect(schema.type).toBe("object");
    expect(schema.additionalProperties).toBe(false);
    const props = Object.keys(schema.properties ?? {});
    expect(props.sort()).toEqual(
      [
        "apiKey",
        "domain",
        "protocol",
        "requestTimeoutSeconds",
        "useServerProxy",
        "defaultImage",
        "maxOutputBytes",
        "sandboxCacheSize",
      ].sort()
    );
  });

  it("warns about statelessness on sandbox_kill", () => {
    const kill = metadata!.tools.find((t) => t.name === "sandbox_kill");
    expect(kill?.description).toMatch(/stateless/i);
    expect(kill?.description).toMatch(/BEFORE calling this tool/i);
  });

  it("documents the useServerProxy default on sandbox_get_endpoint", () => {
    const ep = metadata!.tools.find((t) => t.name === "sandbox_get_endpoint");
    expect(ep?.description).toMatch(/useServerProxy/i);
  });

  it("every tool has a name, label, description, and parameters schema", () => {
    for (const t of metadata!.tools) {
      expect(t.name).toBeTruthy();
      expect(t.label).toBeTruthy();
      expect(t.description.length).toBeGreaterThan(10);
      expect(t.parameters.type).toBe("object");
    }
  });
});
