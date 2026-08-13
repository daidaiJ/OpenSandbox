import { Type } from "typebox";
import type { Static } from "typebox";
import type { SandboxClient } from "../client.js";
import type { PluginConfig } from "../config.js";
import { truncateText } from "../truncate.js";

export const runCommandParams = Type.Object({
  sandboxId: Type.String({
    description: "Sandbox ID from sandbox_create or sandbox_connect.",
  }),
  command: Type.String({
    description: "Shell command to run inside the sandbox.",
  }),
  workingDirectory: Type.Optional(
    Type.String({ description: "Working directory for the command." })
  ),
  timeoutSeconds: Type.Optional(
    Type.Number({
      description:
        "Maximum execution time in seconds; the server terminates the command when reached.",
    })
  ),
});
export type RunCommandParams = Static<typeof runCommandParams>;

export const interruptCommandParams = Type.Object({
  sandboxId: Type.String({ description: "Sandbox ID." }),
  executionId: Type.String({
    description: "Execution ID returned by sandbox_run_command.",
  }),
});
export type InterruptCommandParams = Static<typeof interruptCommandParams>;

export async function execRunCommand(
  client: SandboxClient,
  config: PluginConfig,
  params: RunCommandParams,
  signal?: AbortSignal
): Promise<{
  sandboxId: string;
  executionId: string | null;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  executionTimeMs: number | null;
  truncated: boolean;
}> {
  const sandbox = await client.getSandbox(params.sandboxId);
  const execution = await sandbox.commands.run(
    params.command,
    {
      workingDirectory: params.workingDirectory,
      timeoutSeconds: params.timeoutSeconds,
    },
    undefined,
    signal
  );
  const stdout = execution.logs.stdout.map((m) => m.text).join("");
  const stderr = execution.logs.stderr.map((m) => m.text).join("");
  const out = truncateText(stdout, config.maxOutputBytes);
  const err = truncateText(stderr, config.maxOutputBytes);
  return {
    sandboxId: params.sandboxId,
    executionId: execution.id ?? null,
    exitCode: execution.exitCode ?? null,
    stdout: out.content,
    stderr: err.content,
    executionTimeMs: execution.complete?.executionTimeMs ?? null,
    truncated: out.truncated || err.truncated,
  };
}

export async function execInterruptCommand(
  client: SandboxClient,
  _config: PluginConfig,
  params: InterruptCommandParams
): Promise<{ interrupted: true; executionId: string }> {
  const sandbox = await client.getSandbox(params.sandboxId);
  await sandbox.commands.interrupt(params.executionId);
  return { interrupted: true, executionId: params.executionId };
}
