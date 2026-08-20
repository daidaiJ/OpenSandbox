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

from unittest.mock import MagicMock, patch

import pytest
from fastapi import HTTPException

from opensandbox_server.services.k8s.batchsandbox_provider import BatchSandboxProvider
from opensandbox_server.services.k8s.internal_exec import (
    PodExecRequest,
    exec_in_sandbox_pod,
)
from opensandbox_server.services.k8s.pod_exec import (
    PodExecTimeoutError,
    PodExecUnknownExitCodeError,
)


class TestInternalExec:
    def test_exec_in_sandbox_pod_returns_result(self, mock_k8s_client):
        service = MagicMock()
        service.workload_provider = MagicMock(spec=BatchSandboxProvider)
        service.k8s_client = mock_k8s_client
        service._resolve_namespace_for_lookup.return_value = "opensandbox"
        service.workload_provider.get_workload.return_value = {
            "metadata": {
                "annotations": {
                    "sandbox.opensandbox.io/alloc-status": '{"pods":["pool-pod-1"]}'
                }
            }
        }

        with patch(
            "opensandbox_server.services.k8s.internal_exec.exec_in_pod",
            return_value=("hello\n", "", 0),
        ):
            result = exec_in_sandbox_pod(
                service,
                "sandbox-1",
                PodExecRequest(command=["echo", "hello"]),
            )

        assert result.pod_name == "pool-pod-1"
        assert result.container == "sandbox"
        assert result.exit_code == 0
        assert result.stdout == "hello\n"

    def test_exec_in_sandbox_pod_requires_batchsandbox_provider(self):
        service = MagicMock()
        service.workload_provider = object()

        with pytest.raises(HTTPException) as exc:
            exec_in_sandbox_pod(
                service,
                "sandbox-1",
                PodExecRequest(command=["echo", "hello"]),
            )

        assert exc.value.status_code == 501

    def test_exec_in_sandbox_pod_maps_timeout(self, mock_k8s_client):
        service = MagicMock()
        service.workload_provider = MagicMock(spec=BatchSandboxProvider)
        service.k8s_client = mock_k8s_client
        service._resolve_namespace_for_lookup.return_value = "opensandbox"
        service.workload_provider.get_workload.return_value = {
            "metadata": {
                "annotations": {
                    "sandbox.opensandbox.io/alloc-status": '{"pods":["pool-pod-1"]}'
                }
            }
        }

        with patch(
            "opensandbox_server.services.k8s.internal_exec.exec_in_pod",
            side_effect=PodExecTimeoutError(30),
        ):
            with pytest.raises(HTTPException) as exc:
                exec_in_sandbox_pod(
                    service,
                    "sandbox-1",
                    PodExecRequest(command=["sleep", "60"], timeout_seconds=30),
                )

        assert exc.value.status_code == 504
        assert exc.value.detail["code"] == "KUBERNETES::EXEC_TIMEOUT"

    def test_exec_in_sandbox_pod_maps_unknown_exit_code(self, mock_k8s_client):
        service = MagicMock()
        service.workload_provider = MagicMock(spec=BatchSandboxProvider)
        service.k8s_client = mock_k8s_client
        service._resolve_namespace_for_lookup.return_value = "opensandbox"
        service.workload_provider.get_workload.return_value = {
            "metadata": {
                "annotations": {
                    "sandbox.opensandbox.io/alloc-status": '{"pods":["pool-pod-1"]}'
                }
            }
        }

        with patch(
            "opensandbox_server.services.k8s.internal_exec.exec_in_pod",
            side_effect=PodExecUnknownExitCodeError(),
        ):
            with pytest.raises(HTTPException) as exc:
                exec_in_sandbox_pod(
                    service,
                    "sandbox-1",
                    PodExecRequest(command=["echo", "hello"]),
                )

        assert exc.value.status_code == 502
        assert exc.value.detail["code"] == "KUBERNETES::EXEC_EXIT_UNKNOWN"
