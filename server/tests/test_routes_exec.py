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

from types import SimpleNamespace

from fastapi.testclient import TestClient

from opensandbox_server.api import lifecycle


def test_exec_route_calls_service_and_returns_result(
    client: TestClient,
    auth_headers: dict,
    monkeypatch,
) -> None:
    calls: list[tuple[str, object]] = []

    class StubService:
        @staticmethod
        def exec_in_sandbox_pod(sandbox_id: str, request):
            calls.append((sandbox_id, request))
            return SimpleNamespace(
                pod_name="pool-pod-1",
                container="sandbox",
                exit_code=0,
                stdout="hello\n",
                stderr="",
            )

    monkeypatch.setattr(lifecycle, "sandbox_service", StubService())

    response = client.post(
        "/v1/sandboxes/sbx-001/exec",
        headers=auth_headers,
        json={"command": ["echo", "hello"], "timeoutSeconds": 30},
    )

    assert response.status_code == 200
    assert response.json() == {
        "podName": "pool-pod-1",
        "container": "sandbox",
        "exitCode": 0,
        "stdout": "hello\n",
        "stderr": "",
    }
    assert calls[0][0] == "sbx-001"
    assert calls[0][1].command == ["echo", "hello"]
    assert calls[0][1].timeout_seconds == 30
