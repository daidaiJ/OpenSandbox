#
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
#

from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..models.task_lifecycle_handler_exec_mode import TaskLifecycleHandlerExecMode
from ..types import UNSET, Unset

if TYPE_CHECKING:
    from ..models.task_exec_action import TaskExecAction


T = TypeVar("T", bound="TaskLifecycleHandler")


@_attrs_define
class TaskLifecycleHandler:
    """
    Attributes:
        exec_ (TaskExecAction):
        exec_mode (TaskLifecycleHandlerExecMode | Unset): Hook execution location. Defaults to Local (task-executor
            container).
        timeout_seconds (int | Unset): Maximum seconds the hook may run before it is killed.
    """

    exec_: TaskExecAction
    exec_mode: TaskLifecycleHandlerExecMode | Unset = UNSET
    timeout_seconds: int | Unset = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        exec_ = self.exec_.to_dict()

        exec_mode: str | Unset = UNSET
        if not isinstance(self.exec_mode, Unset):
            exec_mode = self.exec_mode.value

        timeout_seconds = self.timeout_seconds

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "exec": exec_,
            }
        )
        if exec_mode is not UNSET:
            field_dict["execMode"] = exec_mode
        if timeout_seconds is not UNSET:
            field_dict["timeoutSeconds"] = timeout_seconds

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.task_exec_action import TaskExecAction

        d = dict(src_dict)
        exec_ = TaskExecAction.from_dict(d.pop("exec"))

        _exec_mode = d.pop("execMode", UNSET)
        exec_mode: TaskLifecycleHandlerExecMode | Unset
        if isinstance(_exec_mode, Unset):
            exec_mode = UNSET
        else:
            exec_mode = TaskLifecycleHandlerExecMode(_exec_mode)

        timeout_seconds = d.pop("timeoutSeconds", UNSET)

        task_lifecycle_handler = cls(
            exec_=exec_,
            exec_mode=exec_mode,
            timeout_seconds=timeout_seconds,
        )

        task_lifecycle_handler.additional_properties = d
        return task_lifecycle_handler

    @property
    def additional_keys(self) -> list[str]:
        return list(self.additional_properties.keys())

    def __getitem__(self, key: str) -> Any:
        return self.additional_properties[key]

    def __setitem__(self, key: str, value: Any) -> None:
        self.additional_properties[key] = value

    def __delitem__(self, key: str) -> None:
        del self.additional_properties[key]

    def __contains__(self, key: str) -> bool:
        return key in self.additional_properties
