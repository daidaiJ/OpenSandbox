import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import type { ToolPluginExecutionContext } from "openclaw/plugin-sdk/tool-plugin";
import { configSchema, normalizeConfig } from "./config.js";
import type { ConfigInput, PluginConfig } from "./config.js";
import { getSandboxClient } from "./client.js";
import type { SandboxClient } from "./client.js";
import { withErrorHandling } from "./errors.js";
import {
  connectSandboxParams,
  createSandboxParams,
  execConnectSandbox,
  execCreateSandbox,
  execGetEndpoint,
  execGetSandboxInfo,
  execKillSandbox,
  execListSandboxes,
  execRenewSandbox,
  getEndpointParams,
  getSandboxInfoParams,
  killSandboxParams,
  listSandboxesParams,
  renewSandboxParams,
} from "./tools/lifecycle.js";
import {
  execInterruptCommand,
  execRunCommand,
  interruptCommandParams,
  runCommandParams,
} from "./tools/command.js";
import {
  deleteFilesParams,
  execDeleteFiles,
  execListFiles,
  execReadFile,
  execWriteFile,
  listFilesParams,
  readFileParams,
  writeFileParams,
} from "./tools/files.js";

/**
 * Wrap a tool executor into an OpenClaw execute handler.
 *
 * All executors share the signature `(client, config, params, signal)`; this
 * helper resolves the shared client from the validated plugin config, honors
 * the call abort signal, and normalizes SDK errors into readable messages.
 */
function executeWith<P>(
  fn: (
    client: SandboxClient,
    config: PluginConfig,
    params: P,
    signal?: AbortSignal
  ) => Promise<unknown>
) {
  return (params: P, config: ConfigInput, context: ToolPluginExecutionContext) => {
    context.signal?.throwIfAborted();
    const pluginConfig = normalizeConfig(config);
    return withErrorHandling(() =>
      fn(getSandboxClient(pluginConfig), pluginConfig, params, context.signal)
    );
  };
}

export default defineToolPlugin({
  id: "opensandbox-openclaw",
  name: "OpenSandbox Sandbox",
  description:
    "Create and manage OpenSandbox sandboxes: lifecycle management, shell command execution, and file operations. Use sandbox_create or sandbox_connect to obtain a sandbox_id, keep track of it, and pass it to every subsequent tool call.",
  configSchema,
  tools: (tool) => [
    // ------------------------------------------------------------------ lifecycle
    tool({
      name: "sandbox_create",
      label: "Create Sandbox",
      description:
        "Create a new OpenSandbox sandbox and return its sandbox_id. Remember the returned sandbox_id and pass it to all subsequent tools. The sandbox expires after timeoutSeconds (server-side TTL); renew it with sandbox_renew if you need it longer. Sandboxes are stateless: killing or TTL expiry destroys all data inside.",
      parameters: createSandboxParams,
      execute: executeWith(execCreateSandbox),
    }),
    tool({
      name: "sandbox_connect",
      label: "Connect Sandbox",
      description:
        "Connect to an existing sandbox by ID (e.g. after a plugin/process restart, or a sandbox created by another client). Returns the current state of the sandbox.",
      parameters: connectSandboxParams,
      execute: executeWith(execConnectSandbox),
    }),
    tool({
      name: "sandbox_list",
      label: "List Sandboxes",
      description:
        "List sandboxes with optional state/metadata filters and pagination. Returns id, state, and createdAt for each sandbox.",
      parameters: listSandboxesParams,
      execute: executeWith(execListSandboxes),
    }),
    tool({
      name: "sandbox_get_info",
      label: "Get Sandbox Info",
      description:
        "Get status and metadata of a sandbox, including expiresAt. Check expiresAt to know when the sandbox will be destroyed by the server-side TTL, and renew with sandbox_renew if needed.",
      parameters: getSandboxInfoParams,
      execute: executeWith(execGetSandboxInfo),
    }),
    tool({
      name: "sandbox_renew",
      label: "Renew Sandbox",
      description:
        "Extend a sandbox's lifetime by setting a new expiration timeoutSeconds from now. Returns the new expiresAt.",
      parameters: renewSandboxParams,
      execute: executeWith(execRenewSandbox),
    }),
    tool({
      name: "sandbox_kill",
      label: "Kill Sandbox",
      description:
        "Terminates the sandbox and permanently destroys all data inside it. Sandboxes are stateless: kill or TTL expiry destroys all data. BEFORE calling this tool you MUST export any files or final artifacts you need, e.g. read small files with sandbox_read_file, package directories with sandbox_run_command (tar + base64), or download via the endpoint from sandbox_get_endpoint. Once killed, the data is gone.",
      parameters: killSandboxParams,
      execute: executeWith(execKillSandbox),
    }),
    tool({
      name: "sandbox_get_endpoint",
      label: "Get Sandbox Endpoint",
      description:
        "Get an absolute URL for a port inside the sandbox (e.g. a web server the agent started). The endpoint is reachable from the plugin host; when useServerProxy is enabled (default) traffic is routed through the lifecycle server.",
      parameters: getEndpointParams,
      execute: executeWith(execGetEndpoint),
    }),
    // ------------------------------------------------------------------ command
    tool({
      name: "sandbox_run_command",
      label: "Run Command",
      description:
        "Run a shell command in the sandbox in the foreground and collect its output. Non-zero exit codes are returned normally (not as errors); inspect exitCode and stderr. Output is truncated at the plugin maxOutputBytes config. For artifact-producing commands, export the results before the sandbox is killed or expires. Use the returned executionId with sandbox_interrupt_command to interrupt long-running commands.",
      parameters: runCommandParams,
      execute: executeWith(execRunCommand),
    }),
    tool({
      name: "sandbox_interrupt_command",
      label: "Interrupt Command",
      description:
        "Interrupt a running command in the sandbox by its executionId (returned by sandbox_run_command).",
      parameters: interruptCommandParams,
      execute: executeWith(execInterruptCommand),
    }),
    // ------------------------------------------------------------------ files
    tool({
      name: "sandbox_read_file",
      label: "Read File",
      description:
        "Read a text file from the sandbox. Content is truncated at the plugin maxOutputBytes config; use rangeHeader to read large files in chunks. For binary files, use sandbox_run_command (e.g. base64) instead.",
      parameters: readFileParams,
      execute: executeWith(execReadFile),
    }),
    tool({
      name: "sandbox_write_file",
      label: "Write File",
      description:
        "Write text content to a file in the sandbox, creating intermediate directories as needed. Returns the path and byte size written.",
      parameters: writeFileParams,
      execute: executeWith(execWriteFile),
    }),
    tool({
      name: "sandbox_list_files",
      label: "List Files",
      description:
        "List entries of a directory in the sandbox with type, size, and mode. Use depth for recursive listing.",
      parameters: listFilesParams,
      execute: executeWith(execListFiles),
    }),
    tool({
      name: "sandbox_delete_files",
      label: "Delete Files",
      description:
        "Delete files and/or directories in the sandbox. Directories are only removed when recursive is true (always recursively). Note: deletion is permanent and does not honor the stateless-export warning of sandbox_kill; export anything you need first.",
      parameters: deleteFilesParams,
      execute: executeWith(execDeleteFiles),
    }),
  ],
});
