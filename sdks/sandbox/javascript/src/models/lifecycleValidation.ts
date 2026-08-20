/**
 * Copyright 2025 Alibaba Group Holding Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { InvalidArgumentException } from "../core/exceptions.js";
import type {
  TaskExecAction,
  TaskLifecycleExecMode,
  TaskLifecycleHandler,
  TaskProcessLifecycle,
} from "./sandboxes.js";

const VALID_EXEC_MODES = new Set<TaskLifecycleExecMode>(["Local", "Remote"]);

function invalidArgument(message: string): never {
  throw new InvalidArgumentException({ message });
}

export function validateTaskExecAction(
  action: TaskExecAction,
  field = "lifecycle.exec",
): void {
  if (!Array.isArray(action.command) || action.command.length === 0) {
    invalidArgument(`${field}.command must contain at least one element`);
  }
  action.command.forEach((part, index) => {
    if (typeof part !== "string" || part.trim().length === 0) {
      invalidArgument(`${field}.command[${index}] must not be blank`);
    }
  });
}

export function validateTaskLifecycleHandler(
  handler: TaskLifecycleHandler,
  field: string,
): void {
  if (handler.exec == null || typeof handler.exec !== "object") {
    invalidArgument(`${field}.exec is required`);
  } else {
    validateTaskExecAction(handler.exec, `${field}.exec`);
  }

  if (
    handler.execMode != null &&
    !VALID_EXEC_MODES.has(handler.execMode)
  ) {
    invalidArgument(`${field}.execMode must be Local or Remote`);
  }

  if (
    handler.timeoutSeconds != null &&
    (!Number.isInteger(handler.timeoutSeconds) || handler.timeoutSeconds < 1)
  ) {
    invalidArgument(`${field}.timeoutSeconds must be an integer >= 1`);
  }
}

export function validateTaskProcessLifecycle(
  lifecycle: TaskProcessLifecycle,
  field = "lifecycle",
): void {
  if (lifecycle.preStart == null && lifecycle.postStop == null) {
    invalidArgument(`${field}: at least one of preStart or postStop must be set`);
  }

  if (lifecycle.preStart != null) {
    validateTaskLifecycleHandler(lifecycle.preStart, `${field}.preStart`);
  }
  if (lifecycle.postStop != null) {
    validateTaskLifecycleHandler(lifecycle.postStop, `${field}.postStop`);
  }
}
