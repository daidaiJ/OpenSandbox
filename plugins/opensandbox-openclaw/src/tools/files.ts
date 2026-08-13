import { Type } from "typebox";
import type { Static } from "typebox";
import type { SandboxClient } from "../client.js";
import type { PluginConfig } from "../config.js";
import { truncateText } from "../truncate.js";

export const readFileParams = Type.Object({
  sandboxId: Type.String({ description: "Sandbox ID." }),
  path: Type.String({ description: "Absolute path of the file to read." }),
  encoding: Type.Optional(
    Type.String({ description: "Text encoding, e.g. utf-8 (default)." })
  ),
  rangeHeader: Type.Optional(
    Type.String({
      description:
        "HTTP Range header for partial reads, e.g. bytes=0-1023.",
    })
  ),
});
export type ReadFileParams = Static<typeof readFileParams>;

export const writeFileParams = Type.Object({
  sandboxId: Type.String({ description: "Sandbox ID." }),
  path: Type.String({ description: "Absolute path of the file to write." }),
  content: Type.String({ description: "Text content to write." }),
  mode: Type.Optional(
    Type.Number({ description: "POSIX permission bits, e.g. 0o644." })
  ),
});
export type WriteFileParams = Static<typeof writeFileParams>;

export const listFilesParams = Type.Object({
  sandboxId: Type.String({ description: "Sandbox ID." }),
  path: Type.String({ description: "Directory to list." }),
  depth: Type.Optional(
    Type.Number({ description: "Maximum recursion depth." })
  ),
});
export type ListFilesParams = Static<typeof listFilesParams>;

export const deleteFilesParams = Type.Object({
  sandboxId: Type.String({ description: "Sandbox ID." }),
  paths: Type.Array(Type.String(), {
    description: "Files and/or directories to delete.",
  }),
  recursive: Type.Optional(
    Type.Boolean({
      description:
        "Allow deleting directories. Directories are always removed recursively; without this, directory paths are rejected.",
    })
  ),
});
export type DeleteFilesParams = Static<typeof deleteFilesParams>;

export async function execReadFile(
  client: SandboxClient,
  config: PluginConfig,
  params: ReadFileParams
): Promise<{ path: string; content: string; truncated: boolean }> {
  const sandbox = await client.getSandbox(params.sandboxId);
  const content = await sandbox.files.readFile(params.path, {
    encoding: params.encoding,
    range: params.rangeHeader,
  });
  const out = truncateText(content, config.maxOutputBytes);
  return { path: params.path, content: out.content, truncated: out.truncated };
}

export async function execWriteFile(
  client: SandboxClient,
  _config: PluginConfig,
  params: WriteFileParams
): Promise<{ path: string; size: number }> {
  const sandbox = await client.getSandbox(params.sandboxId);
  await sandbox.files.writeFiles([
    { path: params.path, data: params.content, mode: params.mode },
  ]);
  const bytes = new TextEncoder().encode(params.content).length;
  return { path: params.path, size: bytes };
}

export async function execListFiles(
  client: SandboxClient,
  _config: PluginConfig,
  params: ListFilesParams
): Promise<{
  items: { path: string; type: string; size: number; mode: number | null }[];
}> {
  const sandbox = await client.getSandbox(params.sandboxId);
  const entries = await sandbox.files.listDirectory({
    path: params.path,
    depth: params.depth,
  });
  return {
    items: entries.map((f) => ({
      path: f.path,
      type: f.type ?? "file",
      size: f.size ?? 0,
      mode: f.mode ?? null,
    })),
  };
}

export async function execDeleteFiles(
  client: SandboxClient,
  _config: PluginConfig,
  params: DeleteFilesParams
): Promise<{ deleted: string[] }> {
  const sandbox = await client.getSandbox(params.sandboxId);
  const info = await sandbox.files.getFileInfo(params.paths);
  const directories: string[] = [];
  const files: string[] = [];
  for (const p of params.paths) {
    if (info[p]?.type === "directory") {
      directories.push(p);
    } else {
      files.push(p);
    }
  }
  if (directories.length > 0 && !params.recursive) {
    throw new Error(
      `Refusing to delete directories [${directories.join(", ")}] without recursive=true`
    );
  }
  if (directories.length > 0) {
    await sandbox.files.deleteDirectories(directories);
  }
  if (files.length > 0) {
    await sandbox.files.deleteFiles(files);
  }
  return { deleted: params.paths };
}
