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

from ..types import UNSET, Unset

if TYPE_CHECKING:
    from ..models.task_lifecycle_handler import TaskLifecycleHandler


T = TypeVar("T", bound="TaskProcessLifecycle")


@_attrs_define
class TaskProcessLifecycle:
    """Lifecycle hooks attached to a BatchSandbox taskTemplate process.

    Attributes:
        pre_start (TaskLifecycleHandler | Unset):
        post_stop (TaskLifecycleHandler | Unset):
    """

    pre_start: TaskLifecycleHandler | Unset = UNSET
    post_stop: TaskLifecycleHandler | Unset = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        pre_start: dict[str, Any] | Unset = UNSET
        if not isinstance(self.pre_start, Unset):
            pre_start = self.pre_start.to_dict()

        post_stop: dict[str, Any] | Unset = UNSET
        if not isinstance(self.post_stop, Unset):
            post_stop = self.post_stop.to_dict()

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update({})
        if pre_start is not UNSET:
            field_dict["preStart"] = pre_start
        if post_stop is not UNSET:
            field_dict["postStop"] = post_stop

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.task_lifecycle_handler import TaskLifecycleHandler

        d = dict(src_dict)
        _pre_start = d.pop("preStart", UNSET)
        pre_start: TaskLifecycleHandler | Unset
        if isinstance(_pre_start, Unset):
            pre_start = UNSET
        else:
            pre_start = TaskLifecycleHandler.from_dict(_pre_start)

        _post_stop = d.pop("postStop", UNSET)
        post_stop: TaskLifecycleHandler | Unset
        if isinstance(_post_stop, Unset):
            post_stop = UNSET
        else:
            post_stop = TaskLifecycleHandler.from_dict(_post_stop)

        task_process_lifecycle = cls(
            pre_start=pre_start,
            post_stop=post_stop,
        )

        task_process_lifecycle.additional_properties = d
        return task_process_lifecycle

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
