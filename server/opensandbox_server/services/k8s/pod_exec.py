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

"""Helpers for resolving BatchSandbox pods and running Kubernetes exec."""

from __future__ import annotations

import json
import logging
from typing import Any, Dict, Optional, Tuple

from kubernetes.client import ApiException
from kubernetes.stream import stream

from opensandbox_server.services.k8s.client import K8sClient

logger = logging.getLogger(__name__)

ALLOC_STATUS_ANNOTATION = "sandbox.opensandbox.io/alloc-status"
DEFAULT_EXEC_CONTAINER = "task-executor"


def resolve_batchsandbox_pod_name(
    workload: Dict[str, Any],
    *,
    k8s_client: K8sClient,
    namespace: str,
) -> Optional[str]:
    """Resolve the primary pod name for a BatchSandbox workload."""
    annotations = workload.get("metadata", {}).get("annotations") or {}
    raw_alloc = annotations.get(ALLOC_STATUS_ANNOTATION)
    if raw_alloc:
        try:
            alloc = json.loads(raw_alloc)
            pods = alloc.get("pods") or []
            if pods:
                return str(pods[0])
        except (json.JSONDecodeError, TypeError, IndexError):
            logger.warning("Invalid %s annotation on BatchSandbox", ALLOC_STATUS_ANNOTATION)

    status = workload.get("status") or {}
    selector = status.get("selector")
    if not selector:
        return None

    try:
        pods = k8s_client.list_pods(namespace=namespace, label_selector=selector)
    except ApiException:
        return None

    if not pods:
        return None

    running = [pod for pod in pods if getattr(getattr(pod, "status", None), "phase", None) == "Running"]
    target = running[0] if running else pods[0]
    metadata = getattr(target, "metadata", None)
    return getattr(metadata, "name", None)


def exec_in_pod(
    k8s_client: K8sClient,
    *,
    namespace: str,
    pod_name: str,
    command: list[str],
    container: Optional[str] = None,
    timeout_seconds: Optional[int] = None,
) -> Tuple[str, str, int]:
    """Run a command in a pod and return (stdout, stderr, exit_code)."""
    if k8s_client._write_limiter:
        k8s_client._write_limiter.acquire()

    api = k8s_client.get_core_v1_api()
    exec_kwargs: Dict[str, Any] = {
        "name": pod_name,
        "namespace": namespace,
        "command": command,
        "stderr": True,
        "stdin": False,
        "stdout": True,
        "tty": False,
        "_preload_content": False,
    }
    if container:
        exec_kwargs["container"] = container

    ws = stream(api.connect_get_namespaced_pod_exec, **exec_kwargs)
    stdout_chunks: list[str] = []
    stderr_chunks: list[str] = []

    try:
        while ws.is_open():
            ws.update(timeout=timeout_seconds or 1)
            if ws.peek_stdout():
                stdout_chunks.append(ws.read_stdout())
            if ws.peek_stderr():
                stderr_chunks.append(ws.read_stderr())
    finally:
        ws.close()

    exit_code = ws.returncode if ws.returncode is not None else 0
    return "".join(stdout_chunks), "".join(stderr_chunks), exit_code
