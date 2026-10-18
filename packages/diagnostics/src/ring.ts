/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

/** A bounded buffer: past its limit the oldest value is overwritten and counted as dropped. */
export class Ring<T> {
  dropped = 0;
  private data: T[] = [];
  private head = 0;
  private readonly limit: number;

  constructor(limit: number) {
    this.limit = limit;
  }

  push(value: T): void {
    if (this.data.length < this.limit) this.data.push(value);
    else {
      this.data[this.head] = value;
      this.head = (this.head + 1) % this.limit;
      this.dropped++;
    }
  }

  /** Oldest first. */
  values(): T[] {
    return this.head
      ? [...this.data.slice(this.head), ...this.data.slice(0, this.head)]
      : [...this.data];
  }

  get size(): number {
    return this.data.length;
  }

  clear(): void {
    this.data = [];
    this.head = 0;
    this.dropped = 0;
  }
}
