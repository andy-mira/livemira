// SPDX-License-Identifier: Apache-2.0
// The rating module's Worker script.

import { startRater } from './worker.ts';

startRater(globalThis as never);
