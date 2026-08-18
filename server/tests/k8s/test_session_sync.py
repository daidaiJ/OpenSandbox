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

"""Unit tests for silent pooled-session S3 sync helpers."""

import pytest
from fastapi import HTTPException
from unittest.mock import MagicMock

from opensandbox_server.config import SessionSyncConfig
from opensandbox_server.services.constants import (
    SANDBOX_ALLOC_STATUS_ANNOTATION_KEY,
    SANDBOX_SESSION_SYNC_ANNOTATION_KEY,
    SESSION_SYNC_PENDING,
    SESSION_SYNC_PREPARED,
    SandboxErrorCodes,
)
from opensandbox_server.services.k8s.client import PodNotFoundError
from opensandbox_server.services.k8s.session_sync import (
    SessionIdentity,
    SessionPrepareError,
    allocated_pod_name,
    build_post_stop_lifecycle,
    build_prepare_script,
    build_s3_prefix,
    ensure_session_prepared,
    prepare_session,
    resolve_session_identity,
)
from opensandbox_server.tenants.models import TenantEntry


def _config(**overrides) -> SessionSyncConfig:
    values = {
        "enabled": True,
        "prefix_template": "s3://bucket/tenants/{tenant_id}/users/{user_id}/sessions/{session_id}",
    }
    values.update(overrides)
    return SessionSyncConfig(**values)


def test_resolve_identity_from_metadata_user_id():
    identity = resolve_session_identity(
        sandbox_id="11111111-1111-4111-8111-111111111111",
        metadata={"user_id": "alice"},
        extensions={"poolRef": "warm-pool"},
        tenant=None,
        config=_config(),
    )
    assert identity.tenant_id == "default"
    assert identity.user_id == "alice"
    assert identity.session_id == "11111111-1111-4111-8111-111111111111"


def test_resolve_identity_from_extension_and_tenant():
    identity = resolve_session_identity(
        sandbox_id="sbx-1",
        metadata={},
        extensions={"session.user": "bob"},
        tenant=TenantEntry(name="acme", namespace="ns-acme"),
        config=_config(),
    )
    assert identity.tenant_id == "acme"
    assert identity.user_id == "bob"


def test_resolve_identity_rejects_path_traversal_user_id():
    with pytest.raises(ValueError, match="user_id"):
        resolve_session_identity(
            sandbox_id="sbx-1",
            metadata={"user_id": "../evil"},
            extensions=None,
            tenant=None,
            config=_config(),
        )


def test_build_s3_prefix_quotes_identity_segments():
    identity = SessionIdentity(tenant_id="t1", user_id="u-123", session_id="s1")
    prefix = build_s3_prefix(
        "s3://bucket/tenants/{tenant_id}/users/{user_id}/sessions/{session_id}",
        identity,
    )
    assert prefix == "s3://bucket/tenants/t1/users/u-123/sessions/s1"


def test_build_s3_prefix_rejects_unknown_placeholder():
    identity = SessionIdentity(tenant_id="t1", user_id="u1", session_id="s1")
    with pytest.raises(ValueError, match="placeholder"):
        build_s3_prefix("s3://bucket/{nope}/{session_id}", identity)


def test_post_stop_lifecycle_is_local_and_wipes_workspace():
    lifecycle = build_post_stop_lifecycle(_config())
    post_stop = lifecycle["postStop"]
    assert post_stop["execMode"] == "Local"
    assert post_stop["timeoutSeconds"] == 180
    command = post_stop["exec"]["command"]
    assert command[:2] == ["/bin/sh", "-c"]
    script = command[2]
    assert ".osb-sync-out.sh" in script
    assert ".osb-sync-in.pid" in script
    assert "kill" in script
    assert "find" in script
    assert "-mindepth 1 -delete" in script


def test_prepare_script_quotes_prefix_and_tolerates_empty_source():
    script = build_prepare_script(
        _config(),
        "s3://bucket/tenants/t1/users/u1/sessions/s1",
    )
    assert "aws s3 sync" in script
    assert "|| true" in script
    assert "chmod 700" in script
    assert "trap '' HUP" in script
    assert "echo $!" in script
    assert ".osb-sync-in.pid" in script
    assert script.index("chmod 700") < script.index("trap '' HUP")
    assert "s3://bucket/tenants/t1/users/u1/sessions/s1/" in script
    # Metacharacters in a prefix are shell-quoted (defense in depth).
    quoted = build_prepare_script(_config(), "s3://bucket/tenants/t1/users/u1/sessions/s;rm")
    assert "'s3://bucket/tenants/t1/users/u1/sessions/s;rm/'" in quoted


def test_allocated_pod_name_from_alloc_status():
    workload = {
        "metadata": {
            "annotations": {
                SANDBOX_ALLOC_STATUS_ANNOTATION_KEY: '{"pods":["pool-pod-0"]}',
            }
        }
    }
    assert allocated_pod_name(workload) == "pool-pod-0"


def test_ensure_session_prepared_conflict_when_pending():
    workload = {
        "metadata": {
            "annotations": {SANDBOX_SESSION_SYNC_ANNOTATION_KEY: SESSION_SYNC_PENDING}
        }
    }
    with pytest.raises(HTTPException) as exc:
        ensure_session_prepared(workload, _config())
    assert exc.value.status_code == 409
    assert exc.value.detail["code"] == SandboxErrorCodes.SESSION_NOT_PREPARED


def test_ensure_session_prepared_allows_prepared_and_legacy():
    ensure_session_prepared(
        {"metadata": {"annotations": {SANDBOX_SESSION_SYNC_ANNOTATION_KEY: SESSION_SYNC_PREPARED}}},
        _config(),
    )
    ensure_session_prepared({"metadata": {"annotations": {}}}, _config())
    ensure_session_prepared(
        {
            "metadata": {
                "annotations": {SANDBOX_SESSION_SYNC_ANNOTATION_KEY: SESSION_SYNC_PENDING}
            }
        },
        _config(enabled=False),
    )


def test_prepare_session_skips_s3_without_user_and_marks_prepared():
    client = MagicMock()
    identity = SessionIdentity(tenant_id="t1", user_id=None, session_id="s1")
    prepare_session(
        k8s_client=client,
        workload={"metadata": {"annotations": {}}},
        namespace="ns",
        sandbox_id="s1",
        identity=identity,
        config=_config(),
    )
    client.exec_in_pod.assert_not_called()
    body = client.patch_custom_object.call_args.kwargs["body"]
    assert body["metadata"]["annotations"][SANDBOX_SESSION_SYNC_ANNOTATION_KEY] == SESSION_SYNC_PREPARED


def test_prepare_session_execs_then_marks_prepared():
    client = MagicMock()
    client.exec_in_pod.return_value = (0, "")
    identity = SessionIdentity(tenant_id="t1", user_id="alice", session_id="s1")
    workload = {
        "metadata": {
            "annotations": {
                SANDBOX_ALLOC_STATUS_ANNOTATION_KEY: '{"pods":["pool-pod-0"]}',
            }
        }
    }
    prepare_session(
        k8s_client=client,
        workload=workload,
        namespace="ns",
        sandbox_id="s1",
        identity=identity,
        config=_config(),
    )
    client.exec_in_pod.assert_called_once()
    kwargs = client.exec_in_pod.call_args.kwargs
    assert kwargs["name"] == "pool-pod-0"
    assert kwargs["container"] == "task-executor"
    assert kwargs["command"][0:2] == ["/bin/sh", "-c"]
    assert "aws s3 sync" in kwargs["command"][2]
    assert "trap '' HUP" in kwargs["command"][2]
    body = client.patch_custom_object.call_args.kwargs["body"]
    assert body["metadata"]["annotations"][SANDBOX_SESSION_SYNC_ANNOTATION_KEY] == SESSION_SYNC_PREPARED


def test_prepare_session_nonzero_exit_raises():
    client = MagicMock()
    client.exec_in_pod.return_value = (1, "denied")
    identity = SessionIdentity(tenant_id="t1", user_id="alice", session_id="s1")
    workload = {
        "metadata": {
            "annotations": {
                SANDBOX_ALLOC_STATUS_ANNOTATION_KEY: '{"pods":["pool-pod-0"]}',
            }
        }
    }
    with pytest.raises(SessionPrepareError, match="exit 1"):
        prepare_session(
            k8s_client=client,
            workload=workload,
            namespace="ns",
            sandbox_id="s1",
            identity=identity,
            config=_config(),
        )
    client.patch_custom_object.assert_not_called()


def test_prepare_session_pod_not_found_maps_to_conflict():
    client = MagicMock()
    client.exec_in_pod.side_effect = PodNotFoundError("ns", "pool-pod-0")
    identity = SessionIdentity(tenant_id="t1", user_id="alice", session_id="s1")
    workload = {
        "metadata": {
            "annotations": {
                SANDBOX_ALLOC_STATUS_ANNOTATION_KEY: '{"pods":["pool-pod-0"]}',
            }
        }
    }
    with pytest.raises(SessionPrepareError, match="not found") as exc:
        prepare_session(
            k8s_client=client,
            workload=workload,
            namespace="ns",
            sandbox_id="s1",
            identity=identity,
            config=_config(),
        )
    assert exc.value.code == SandboxErrorCodes.K8S_POD_NOT_FOUND
    assert exc.value.http_status == 409
    client.patch_custom_object.assert_not_called()
