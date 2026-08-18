# Copyright 2026 Alibaba Group Holding Ltd.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""Silent pooled-session S3 workspace sync (internal create/delete path).

Not a public API. Business callers still use create → use → delete. Restore and
the postStop sync-out script are injected by the lifecycle server.
"""

from __future__ import annotations

import json
import logging
import re
import shlex
import time
from dataclasses import dataclass
from typing import Any, Dict, Mapping, Optional

from fastapi import HTTPException, status

from opensandbox_server.config import SessionSyncConfig
from opensandbox_server.services.constants import (
    SANDBOX_ALLOC_STATUS_ANNOTATION_KEY,
    SANDBOX_SESSION_SYNC_ANNOTATION_KEY,
    SESSION_SYNC_PENDING,
    SESSION_SYNC_PREPARED,
    SandboxErrorCodes,
)
from opensandbox_server.services.k8s.client import (
    OPENSANDBOX_API_GROUP,
    OPENSANDBOX_API_VERSION,
    K8sClient,
    PodNotFoundError,
)
from opensandbox_server.tenants.models import TenantEntry

logger = logging.getLogger(__name__)

_IDENTITY_RE = re.compile(r"^[A-Za-z0-9._-]{1,128}$")
_S3_PREFIX_RE = re.compile(r"^s3://[a-z0-9.\-]+(?:/[A-Za-z0-9._\-]+)*/?$")
_SYNC_IN_PID_NAME = ".osb-sync-in.pid"
_BATCHSANDBOX_PLURAL = "batchsandboxes"


class SessionPrepareError(Exception):
    """Internal prepare (exec / annotation) failed after the pod was Ready."""

    def __init__(
        self,
        message: str,
        *,
        code: str = SandboxErrorCodes.SESSION_PREPARE_FAILED,
        http_status: int = status.HTTP_500_INTERNAL_SERVER_ERROR,
    ):
        super().__init__(message)
        self.code = code
        self.http_status = http_status


@dataclass(frozen=True)
class SessionIdentity:
    tenant_id: str
    user_id: Optional[str]
    session_id: str

    @property
    def has_user(self) -> bool:
        return bool(self.user_id)


class _StrictFormat(dict):
    def __missing__(self, key: str) -> str:
        raise ValueError(f"Unknown session_sync prefix placeholder {{{key}}}")


def session_sync_applies(has_pool_ref: bool, config: SessionSyncConfig) -> bool:
    return bool(has_pool_ref and config.enabled)


def _normalize_identity_segment(raw: Optional[str], *, field: str) -> Optional[str]:
    if raw is None:
        return None
    value = str(raw).strip()
    if not value:
        return None
    if not _IDENTITY_RE.fullmatch(value):
        raise ValueError(
            f"Invalid {field} for session sync: must match {_IDENTITY_RE.pattern}"
        )
    return value


def _mapping_get(mapping: Optional[Mapping[str, Any]], key: str) -> Optional[str]:
    if not mapping or not key:
        return None
    value = mapping.get(key)
    if value is None:
        return None
    return str(value)


def resolve_session_identity(
    *,
    sandbox_id: str,
    metadata: Optional[Mapping[str, Any]],
    extensions: Optional[Mapping[str, Any]],
    tenant: Optional[TenantEntry],
    config: SessionSyncConfig,
) -> SessionIdentity:
    """Resolve tenant/user/session for the S3 prefix. session_id is the sandbox id."""
    session_id = _normalize_identity_segment(sandbox_id, field="session_id")
    if session_id is None:
        raise ValueError("sandbox_id is required for session sync")

    tenant_id = None
    if tenant is not None and tenant.name:
        tenant_id = _normalize_identity_segment(tenant.name, field="tenant_id")
    if tenant_id is None:
        tenant_id = _normalize_identity_segment(
            _mapping_get(metadata, "tenant_id"),
            field="tenant_id",
        )
    if tenant_id is None:
        tenant_id = _normalize_identity_segment(
            config.default_tenant_id,
            field="default_tenant_id",
        )
    if tenant_id is None:
        raise ValueError("session_sync.default_tenant_id must be a non-empty identity segment")

    user_id = _normalize_identity_segment(
        _mapping_get(metadata, config.user_id_metadata_key),
        field=config.user_id_metadata_key,
    )
    if user_id is None:
        user_id = _normalize_identity_segment(
            _mapping_get(extensions, config.user_id_extension_key),
            field=config.user_id_extension_key,
        )

    return SessionIdentity(tenant_id=tenant_id, user_id=user_id, session_id=session_id)


def build_s3_prefix(template: str, identity: SessionIdentity) -> str:
    if not identity.user_id:
        raise ValueError("user_id is required to build a session S3 prefix")
    prefix = template.format_map(
        _StrictFormat(
            tenant_id=identity.tenant_id,
            user_id=identity.user_id,
            session_id=identity.session_id,
        )
    ).strip()
    if not _S3_PREFIX_RE.fullmatch(prefix.rstrip("/")) and not _S3_PREFIX_RE.fullmatch(prefix):
        raise ValueError("Resolved session_sync prefix is not a valid s3:// URI")
    return prefix.rstrip("/")


def build_post_stop_lifecycle(config: SessionSyncConfig) -> Dict[str, Any]:
    """Fixed Local postStop: stop in-flight restore, run hook if present, wipe workspace."""
    workspace = config.workspace_path.rstrip("/")
    hook = f"{workspace}/{config.sync_out_script_name}"
    pidfile = f"{workspace}/{_SYNC_IN_PID_NAME}"
    script = (
        "set -eu\n"
        f"HOOK={shlex.quote(hook)}\n"
        f"WORKSPACE={shlex.quote(workspace)}\n"
        f"PIDFILE={shlex.quote(pidfile)}\n"
        'if [ -f "$PIDFILE" ]; then\n'
        '  pid=$(cat "$PIDFILE" 2>/dev/null || true)\n'
        '  rm -f "$PIDFILE"\n'
        '  if [ -n "$pid" ]; then\n'
        '    kill "$pid" 2>/dev/null || true\n'
        '    i=0\n'
        '    while [ "$i" -lt 15 ] && kill -0 "$pid" 2>/dev/null; do\n'
        '      sleep 1\n'
        '      i=$((i + 1))\n'
        '    done\n'
        '    kill -9 "$pid" 2>/dev/null || true\n'
        '  fi\n'
        'fi\n'
        'if [ -x "$HOOK" ]; then "$HOOK"; fi\n'
        'find "$WORKSPACE" -mindepth 1 -delete\n'
    )
    return {
        "postStop": {
            "execMode": "Local",
            "timeoutSeconds": config.post_stop_timeout_seconds,
            "exec": {
                "command": ["/bin/sh", "-c", script],
            },
        }
    }


def _sync_commands(config: SessionSyncConfig, prefix: str) -> tuple[str, str]:
    workspace = config.workspace_path.rstrip("/") + "/"
    prefix_slash = prefix.rstrip("/") + "/"
    ws_q = shlex.quote(workspace)
    prefix_q = shlex.quote(prefix_slash)
    exclude_flags = (
        f"--exclude {shlex.quote(config.sync_out_script_name)} "
        f"--exclude {shlex.quote(_SYNC_IN_PID_NAME)}"
    )
    if config.tool == "rclone":
        sync_in = f"rclone copy {prefix_q} {ws_q} {exclude_flags}"
        sync_out = f"rclone copy {ws_q} {prefix_q} {exclude_flags}"
    else:
        sync_in = f"aws s3 sync {prefix_q} {ws_q} {exclude_flags}"
        sync_out = f"aws s3 sync {ws_q} {prefix_q} {exclude_flags}"
    return sync_in, sync_out


def build_prepare_script(config: SessionSyncConfig, prefix: str) -> str:
    """Write the postStop sync-out hook and start inbound restore in the background.

    Create only waits for this launcher to return, not for the S3 CLI to finish.
    Prefixes are shell-quoted. Credentials must come from the executor
    (IRSA/Secret), never from this script.
    """
    workspace = config.workspace_path.rstrip("/")
    hook = f"{workspace}/{config.sync_out_script_name}"
    pidfile = f"{workspace}/{_SYNC_IN_PID_NAME}"
    hook_q = shlex.quote(hook)
    pidfile_q = shlex.quote(pidfile)
    sync_in, sync_out = _sync_commands(config, prefix)
    background = (
        f"( trap '' HUP; {sync_in} || true ) >/dev/null 2>&1 & "
        f"echo $! > {pidfile_q}"
    )
    return (
        "set -eu\n"
        f"cat > {hook_q} << 'OSB_SYNC_OUT_EOF'\n"
        "#!/bin/sh\n"
        "set -eu\n"
        f"{sync_out}\n"
        "OSB_SYNC_OUT_EOF\n"
        f"chmod 700 {hook_q}\n"
        f"{background}\n"
    )


def allocated_pod_name(workload: Mapping[str, Any]) -> Optional[str]:
    metadata = workload.get("metadata") if isinstance(workload, Mapping) else None
    annotations = (metadata or {}).get("annotations") or {}
    if not isinstance(annotations, Mapping):
        return None
    raw = annotations.get(SANDBOX_ALLOC_STATUS_ANNOTATION_KEY)
    if not raw:
        return None
    try:
        parsed = json.loads(raw)
    except (TypeError, ValueError, json.JSONDecodeError):
        return None
    pods = parsed.get("pods") if isinstance(parsed, dict) else None
    if not isinstance(pods, list) or not pods:
        return None
    name = pods[0]
    if isinstance(name, str) and name.strip():
        return name.strip()
    return None


def session_sync_annotation_value(workload: Mapping[str, Any]) -> Optional[str]:
    metadata = workload.get("metadata") if isinstance(workload, Mapping) else None
    annotations = (metadata or {}).get("annotations") or {}
    if not isinstance(annotations, Mapping):
        return None
    value = annotations.get(SANDBOX_SESSION_SYNC_ANNOTATION_KEY)
    return str(value) if value is not None else None


def ensure_session_prepared(workload: Mapping[str, Any], config: SessionSyncConfig) -> None:
    """Proxy/get_endpoint gate: Ready but still pending prepare → 409."""
    if not config.enabled or not config.proxy_gate_unprepared:
        return
    value = session_sync_annotation_value(workload)
    if value != SESSION_SYNC_PENDING:
        return
    raise HTTPException(
        status_code=status.HTTP_409_CONFLICT,
        detail={
            "code": SandboxErrorCodes.SESSION_NOT_PREPARED,
            "message": (
                "Pooled sandbox session prepare has not been injected yet. "
                "Retry after create returns, or recreate the sandbox."
            ),
        },
    )


def _mark_prepared(k8s_client: K8sClient, namespace: str, sandbox_id: str) -> None:
    k8s_client.patch_custom_object(
        group=OPENSANDBOX_API_GROUP,
        version=OPENSANDBOX_API_VERSION,
        namespace=namespace,
        plural=_BATCHSANDBOX_PLURAL,
        name=sandbox_id,
        body={
            "metadata": {
                "annotations": {
                    SANDBOX_SESSION_SYNC_ANNOTATION_KEY: SESSION_SYNC_PREPARED,
                }
            }
        },
    )


def prepare_session(
    *,
    k8s_client: K8sClient,
    workload: Mapping[str, Any],
    namespace: str,
    sandbox_id: str,
    identity: SessionIdentity,
    config: SessionSyncConfig,
) -> None:
    """Inject the sync-out hook, start inbound restore in the background, mark prepared.

    Create does not wait for the S3 CLI. When ``identity.user_id`` is missing,
    skip S3 (postStop still wipes the workspace) and only flip the prepared
    annotation so the proxy gate opens.
    """
    if not config.enabled:
        return

    if not identity.has_user:
        logger.info(
            "session sync: sandbox=%s has no user_id; skipping S3 restore",
            sandbox_id,
        )
        _mark_prepared(k8s_client, namespace, sandbox_id)
        return

    try:
        prefix = build_s3_prefix(config.prefix_template, identity)
    except ValueError as exc:
        raise SessionPrepareError(str(exc), code=SandboxErrorCodes.INVALID_PARAMETER) from exc

    pod_name = allocated_pod_name(workload)
    if not pod_name:
        raise SessionPrepareError(
            "Allocated pod name is missing; cannot restore session workspace"
        )

    script = build_prepare_script(config, prefix)
    started = time.monotonic()
    try:
        exit_code, output = k8s_client.exec_in_pod(
            namespace=namespace,
            name=pod_name,
            command=["/bin/sh", "-c", script],
            container=config.container,
            timeout_seconds=config.prepare_timeout_seconds,
        )
    except TimeoutError as exc:
        raise SessionPrepareError(
            f"Session prepare launcher timed out after {config.prepare_timeout_seconds}s"
        ) from exc
    except PodNotFoundError as exc:
        logger.warning(
            "session sync exec pod not found sandbox=%s pod=%s namespace=%s",
            sandbox_id,
            pod_name,
            namespace,
        )
        raise SessionPrepareError(
            f"Allocated pod '{pod_name}' was not found; cannot prepare session workspace",
            code=SandboxErrorCodes.K8S_POD_NOT_FOUND,
            http_status=status.HTTP_409_CONFLICT,
        ) from exc
    except Exception as exc:
        logger.exception("session sync exec failed sandbox=%s pod=%s", sandbox_id, pod_name)
        raise SessionPrepareError("Session prepare exec failed") from exc

    elapsed_ms = int((time.monotonic() - started) * 1000)
    if exit_code != 0:
        logger.error(
            "session sync prepare launcher failed sandbox=%s pod=%s exit=%s duration_ms=%s",
            sandbox_id,
            pod_name,
            exit_code,
            elapsed_ms,
        )
        raise SessionPrepareError(
            f"Session prepare launcher failed (exit {exit_code})"
        )

    logger.info(
        "session sync restore started sandbox=%s pod=%s duration_ms=%s",
        sandbox_id,
        pod_name,
        elapsed_ms,
    )
    if output:
        logger.debug("session sync restore output sandbox=%s chars=%s", sandbox_id, len(output))

    try:
        _mark_prepared(k8s_client, namespace, sandbox_id)
    except Exception as exc:
        logger.exception("session sync mark-prepared failed sandbox=%s", sandbox_id)
        raise SessionPrepareError("Failed to mark session as prepared") from exc
