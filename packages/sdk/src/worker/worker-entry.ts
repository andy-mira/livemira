/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// Entry of the vision Worker. The single-file build embeds this module's bundle as the Worker source, and also
// writes it as a separate file for hosts whose content security policy forbids blob: Workers.

import { startVisionWorker, type VisionWorkerScope } from './start.ts';

startVisionWorker(globalThis as unknown as VisionWorkerScope);
