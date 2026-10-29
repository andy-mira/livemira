// SPDX-License-Identifier: Apache-2.0

import type { RatingErrorCode, RatingErrorShape } from './api.ts';

export class RatingError extends Error implements RatingErrorShape {
  override readonly name = 'RatingError';
  readonly code: RatingErrorCode;

  constructor(code: RatingErrorCode, message: string, options: { cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
  }
}
