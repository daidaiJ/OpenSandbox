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

from opensandbox_server.api.schema import (
    CreateSandboxRequest,
    TaskExecAction,
    TaskLifecycleHandler,
    TaskProcessLifecycle,
)
from opensandbox_server.services.k8s.batchsandbox_provider import BatchSandboxProvider
from opensandbox_server.services.k8s.pod_exec import (
    ALLOC_STATUS_ANNOTATION,
    resolve_batchsandbox_pod_name,
)


class TestResolveBatchSandboxPodName:
    def test_prefers_alloc_status_annotation(self):
        workload = {
            "metadata": {"annotations": {ALLOC_STATUS_ANNOTATION: '{"pods":["pool-pod-1"]}'}},
            "status": {"selector": "app=sandbox"},
        }
        pod_name = resolve_batchsandbox_pod_name(
            workload,
            k8s_client=MagicMock(),
            namespace="opensandbox",
        )
        assert pod_name == "pool-pod-1"

    def test_falls_back_to_running_pod_from_selector(self):
        pod = MagicMock()
        pod.metadata.name = "running-pod"
        pod.status.phase = "Running"
        k8s_client = MagicMock()
        k8s_client.list_pods.return_value = [pod]

        workload = {"metadata": {"annotations": {}}, "status": {"selector": "app=sandbox"}}
        pod_name = resolve_batchsandbox_pod_name(
            workload,
            k8s_client=k8s_client,
            namespace="opensandbox",
        )
        assert pod_name == "running-pod"
        k8s_client.list_pods.assert_called_once_with(
            namespace="opensandbox",
            label_selector="app=sandbox",
        )


class TestBatchSandboxLifecycleTaskTemplate:
    def test_build_task_template_includes_post_stop(self, mock_k8s_client):
        provider = BatchSandboxProvider(mock_k8s_client)
        lifecycle = TaskProcessLifecycle(
            postStop=TaskLifecycleHandler(
                exec=TaskExecAction(command=["/bin/sh", "-c", "echo done"]),
                execMode="Local",
                timeoutSeconds=30,
            )
        )

        result = provider._build_task_template(
            entrypoint=["sleep", "3600"],
            env={},
            sandbox_id="bs-1",
            lifecycle=lifecycle,
        )

        post_stop = result["spec"]["process"]["lifecycle"]["postStop"]
        assert post_stop["exec"]["command"] == ["/bin/sh", "-c", "echo done"]
        assert post_stop["execMode"] == "Local"
        assert post_stop["timeoutSeconds"] == 30

    def test_pool_create_generates_task_template_when_post_stop_present(self, mock_k8s_client):
        provider = BatchSandboxProvider(mock_k8s_client)
        mock_k8s_client.create_custom_object.return_value = {
            "metadata": {"name": "sandbox-1", "uid": "uid-1"},
        }

        provider._create_workload_from_pool(
            batchsandbox_name="sandbox-1",
            namespace="opensandbox",
            labels={},
            pool_ref="my-pool",
            expires_at=None,
            entrypoint=["sleep", "3600"],
            env={},
            lifecycle=TaskProcessLifecycle(
                postStop=TaskLifecycleHandler(
                    exec=TaskExecAction(command=["/bin/sh", "-c", "cleanup"]),
                )
            ),
        )

        body = mock_k8s_client.create_custom_object.call_args.kwargs["body"]
        assert body["spec"]["taskTemplate"]["spec"]["process"]["lifecycle"]["postStop"]["exec"]["command"] == [
            "/bin/sh",
            "-c",
            "cleanup",
        ]


class TestCreateSandboxRequestLifecycleValidation:
    def test_lifecycle_requires_pool_ref(self):
        with pytest.raises(ValueError, match="lifecycle hooks require extensions.poolRef"):
            CreateSandboxRequest(
                image={"uri": "python:3.11"},
                entrypoint=["python"],
                resourceLimits={"cpu": "1", "memory": "512Mi"},
                lifecycle=TaskProcessLifecycle(
                    postStop=TaskLifecycleHandler(
                        exec=TaskExecAction(command=["echo", "cleanup"]),
                    )
                ),
            )

    @patch("opensandbox_server.services.k8s.pod_exec.stream")
    def test_exec_in_pod_collects_stdout_and_exit_code(self, mock_stream, mock_k8s_client):
        from opensandbox_server.services.k8s.pod_exec import exec_in_pod

        ws = MagicMock()
        ws.is_open.side_effect = [True, False]
        ws.peek_stdout.side_effect = [True, False]
        ws.peek_stderr.side_effect = [False, False]
        ws.read_stdout.return_value = "hello\n"
        ws.returncode = 0
        mock_stream.return_value = ws
        mock_k8s_client._write_limiter = None
        mock_k8s_client.get_core_v1_api.return_value = MagicMock()

        stdout, stderr, exit_code = exec_in_pod(
            mock_k8s_client,
            namespace="opensandbox",
            pod_name="pool-pod-1",
            command=["echo", "hello"],
            container="sandbox",
        )

        assert stdout == "hello\n"
        assert stderr == ""
        assert exit_code == 0
        ws.close.assert_called_once()

    @patch("opensandbox_server.services.k8s.pod_exec.time.monotonic")
    @patch("opensandbox_server.services.k8s.pod_exec.stream")
    def test_exec_in_pod_times_out(self, mock_stream, mock_monotonic, mock_k8s_client):
        from opensandbox_server.services.k8s.pod_exec import PodExecTimeoutError, exec_in_pod

        ws = MagicMock()
        ws.is_open.return_value = True
        ws.peek_stdout.return_value = False
        ws.peek_stderr.return_value = False
        mock_stream.return_value = ws
        mock_k8s_client._write_limiter = None
        mock_k8s_client.get_core_v1_api.return_value = MagicMock()
        mock_monotonic.side_effect = [0.0, 0.4, 2.0]

        with pytest.raises(PodExecTimeoutError, match="timed out after 1s"):
            exec_in_pod(
                mock_k8s_client,
                namespace="opensandbox",
                pod_name="pool-pod-1",
                command=["sleep", "30"],
                timeout_seconds=1,
            )
        ws.close.assert_called_once()

    @patch("opensandbox_server.services.k8s.pod_exec.stream")
    def test_exec_in_pod_rejects_missing_exit_code(self, mock_stream, mock_k8s_client):
        from opensandbox_server.services.k8s.pod_exec import PodExecUnknownExitCodeError, exec_in_pod

        ws = MagicMock()
        ws.is_open.side_effect = [True, False]
        ws.peek_stdout.return_value = False
        ws.peek_stderr.return_value = False
        ws.returncode = None
        mock_stream.return_value = ws
        mock_k8s_client._write_limiter = None
        mock_k8s_client.get_core_v1_api.return_value = MagicMock()

        with pytest.raises(PodExecUnknownExitCodeError, match="without a process exit code"):
            exec_in_pod(
                mock_k8s_client,
                namespace="opensandbox",
                pod_name="pool-pod-1",
                command=["echo", "hello"],
            )

    def test_empty_lifecycle_is_treated_as_none(self):
        request = CreateSandboxRequest(
            extensions={"poolRef": "my-pool"},
            lifecycle=TaskProcessLifecycle(),
        )
        assert request.lifecycle is None
