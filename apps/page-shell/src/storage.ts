/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

/** localStorage that never throws (private mode, blocked storage); a failure only loses the remembered value. */
export const safeStorage = {
  get(key: string): string | null {
    try {
      return globalThis.localStorage?.getItem(key) ?? null;
    } catch {
      return null;
    }
  },
  set(key: string, value: string | null): void {
    try {
      if (value === null) globalThis.localStorage?.removeItem(key);
      else globalThis.localStorage?.setItem(key, value);
    } catch {
      // Not remembered.
    }
  },
};
