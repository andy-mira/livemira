/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// Serialized form: JSON text {"payload": "<bundle JSON>", "sha256": "<hex of the payload's UTF-8 bytes>"}.

import { EngineError, type TargetBundle } from '@livemira/contracts';
import { preflightTarget, sha256Hex, validateTarget } from '@livemira/recognition';

/** Largest serialized target, in UTF-8 bytes. */
export const MAX_SERIALIZED_BYTES = 24_000_000;

const encoder = new TextEncoder();

const invalid = (message: string): never => {
  throw new EngineError('INVALID_TARGET', message, { isRecoverable: false });
};

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (cause) {
    throw new EngineError('INVALID_TARGET', 'Malformed target text', {
      isRecoverable: false,
      cause,
    });
  }
}

/** Validates a bundle completely and serializes it with an integrity hash. */
export async function serializeTarget(target: TargetBundle): Promise<string> {
  preflightTarget(target);
  const snapshot = structuredClone(target);
  await validateTarget(snapshot);
  const payload = JSON.stringify(snapshot);
  if (encoder.encode(payload).byteLength > MAX_SERIALIZED_BYTES)
    invalid('Target exceeds serialization budget');
  const text = JSON.stringify({ payload, sha256: await sha256Hex(encoder.encode(payload)) });
  if (encoder.encode(text).byteLength > MAX_SERIALIZED_BYTES)
    invalid('Target exceeds serialization budget');
  return text;
}

/** Parses serialized text, checks its integrity hash and validates the bundle completely. */
export async function parseTarget(text: string): Promise<TargetBundle> {
  if (
    typeof text !== 'string' ||
    text.length > MAX_SERIALIZED_BYTES ||
    encoder.encode(text).byteLength > MAX_SERIALIZED_BYTES
  ) {
    invalid('Target exceeds serialization budget');
  }
  const envelope = parseJson(text) as { payload?: unknown; sha256?: unknown } | null;
  if (
    !envelope ||
    typeof envelope.payload !== 'string' ||
    typeof envelope.sha256 !== 'string' ||
    (await sha256Hex(encoder.encode(envelope.payload))) !== envelope.sha256
  ) {
    invalid('Target integrity mismatch');
  }
  return validateTarget(parseJson(envelope!.payload as string));
}
