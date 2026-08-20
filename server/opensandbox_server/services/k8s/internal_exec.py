# Copyright 2025 Alibaba Group Holding Ltd.
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

"""Internal-only Kubernetes pod exec helpers for the lifecycle server."""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

from fastapi import HTTPException, status

from opensandbox_server.services.constants import SandboxErrorCodes
from opensandbox_server.services.k8s.batchsandbox_provider import BatchSandboxProvider
from opensandbox_server.services.k8s.error_helpers import _build_k8s_api_error, _is_not_found_error
from opensandbox_server.services.k8s.pod_exec import (
    DEFAULT_EXEC_CONTAINER,
    exec_in_pod,
    resolve_batchsandbox_pod_name,
)
from opensandbox_server.services.k8s.workload_access import _get_workload_or_404

if TYPE_CHECKING:
    from opensandbox_server.services.k8s.client import K8sClient
    from opensandbox_server.services.k8s.kubernetes_service import KubernetesSandboxService


@dataclass(frozen=True)
class PodExecRequest:
    """Internal request to exec a command in a sandbox pod."""

    command: list[str]
    container: str | None = None
    timeout_seconds: int | None = None


@dataclass(frozen=True)
class PodExecResult:
    """Internal result of a sandbox pod exec operation."""

    pod_name: str
    container: str
    exit_code: int
    stdout: str = ""
    stderr: str = ""


def exec_in_sandbox_pod(
    service: "KubernetesSandboxService",
    sandbox_id: str,
    request: PodExecRequest,
) -> PodExecResult:
    """Exec a command in the primary pod backing a BatchSandbox sandbox."""
    if not isinstance(service.workload_provider, BatchSandboxProvider):
        raise HTTPException(
            status_code=status.HTTP_501_NOT_IMPLEMENTED,
            detail={
                "code": SandboxErrorCodes.K8S_EXEC_NOT_SUPPORTED,
                "message": "Pod exec is supported only for BatchSandbox workloads.",
            },
        )

    ns = service._resolve_namespace_for_lookup(sandbox_id)
    workload = _get_workload_or_404(service.workload_provider, ns, sandbox_id)
    pod_name = resolve_batchsandbox_pod_name(
        workload,
        k8s_client=service.k8s_client,
        namespace=ns,
    )
    if not pod_name:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "code": SandboxErrorCodes.K8S_POD_NOT_FOUND,
                "message": f"No pod is allocated yet for sandbox {sandbox_id}.",
            },
        )

    container = request.container or DEFAULT_EXEC_CONTAINER
    try:
        stdout, stderr, exit_code = exec_in_pod(
            service.k8s_client,
            namespace=ns,
            pod_name=pod_name,
            command=request.command,
            container=container,
            timeout_seconds=request.timeout_seconds,
        )
    except Exception as exc:
        if _is_not_found_error(exc):
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail={
                    "code": SandboxErrorCodes.K8S_POD_NOT_FOUND,
                    "message": f"Pod '{pod_name}' for sandbox {sandbox_id} was not found.",
                },
            ) from exc
        raise _build_k8s_api_error(exc, f"exec in sandbox {sandbox_id}") from exc

    return PodExecResult(
        pod_name=pod_name,
        container=container,
        exit_code=exit_code,
        stdout=stdout,
        stderr=stderr,
    )
