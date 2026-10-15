import { z } from 'zod';
import { LIMITS } from './constants.js';

/** HTTP API request/response contracts (served alongside the WebSocket). */

export const PairRequestSchema = z.object({
  /** Six digits; separators such as "-" or spaces are ignored. */
  code: z.string().min(6).max(16),
  deviceName: z
    .string()
    .trim()
    .min(1)
    .max(LIMITS.maxDeviceNameLength)
    // Printed in the PC's terminal: no escape sequences, line breaks or bidi tricks.
    .regex(/^[^\p{Cc}\p{Cf}]+$/u, 'Device name contains control characters'),
});
export type PairRequest = z.infer<typeof PairRequestSchema>;

export interface PairResponse {
  deviceId: string;
  deviceName: string;
}

export interface AgentInfoResponse {
  name: 'voicecode-agent';
  version: string;
  /** The PC's name; withheld from unpaired visitors arriving over a public tunnel. */
  hostname?: string;
  protocolVersion: number;
  /** True when the request carried a valid device cookie. */
  paired: boolean;
  device?: { id: string; name: string };
}

/** Normalises a pairing code typed by a human ("482-917", "482 917") to digits only. */
export function normalizePairingCode(code: string): string {
  return code.replace(/[\s-]/g, '');
}

/** `POST /api/attachments` (raw image body, cookie auth): the stored image's id. */
export interface AttachmentResponse {
  id: string;
  mediaType: string;
  bytes: number;
}
