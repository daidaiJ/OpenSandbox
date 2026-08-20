// Copyright 2026 Alibaba Group Holding Ltd.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import assert from "node:assert/strict";
import test from "node:test";

import { InvalidArgumentException, validateTaskProcessLifecycle } from "../dist/index.js";

test("validateTaskProcessLifecycle treats empty lifecycle as no-op", () => {
  assert.doesNotThrow(() => validateTaskProcessLifecycle({}));
});

test("validateTaskProcessLifecycle accepts postStop hook", () => {
  assert.doesNotThrow(() =>
    validateTaskProcessLifecycle({
      postStop: {
        exec: { command: ["echo", "cleanup"] },
        execMode: "Local",
        timeoutSeconds: 30,
      },
    }),
  );
});

test("validateTaskProcessLifecycle rejects blank command part", () => {
  assert.throws(
    () =>
      validateTaskProcessLifecycle({
        postStop: {
          exec: { command: [" "] },
        },
      }),
    InvalidArgumentException,
  );
});

test("validateTaskProcessLifecycle rejects invalid exec mode", () => {
  assert.throws(
    () =>
      validateTaskProcessLifecycle({
        postStop: {
          exec: { command: ["echo"] },
          execMode: "Invalid",
        },
      }),
    InvalidArgumentException,
  );
});
