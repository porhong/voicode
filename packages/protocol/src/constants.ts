/**
 * Bump when a change to the wire format is not backwards compatible.
 * The agent rejects clients that speak a different major version.
 */
export const PROTOCOL_VERSION = 1;

/** WebSocket endpoint path served by the agent. */
export const WS_PATH = '/ws';

/** Device cookie. The `__Host-` prefix forces Secure, Path=/ and no Domain attribute. */
export const DEVICE_COOKIE = '__Host-vc_device';

/** Upper bounds that keep a misbehaving or malicious client from flooding the agent. */
export const LIMITS = {
  /** Largest single relative mouse delta accepted, in device pixels. */
  maxMouseDelta: 2000,
  /** Largest scroll delta accepted per message, in wheel units (120 = one notch). */
  maxScrollDelta: 2400,
  /** Max characters of a prompt sent to Claude. */
  maxPromptLength: 20_000,
  /** Max size of one inbound WebSocket frame in bytes. */
  maxFrameBytes: 64 * 1024,
  /** Max length of a device name. */
  maxDeviceNameLength: 64,
} as const;

export const MOUSE_BUTTONS = ['left', 'right', 'middle'] as const;
export type MouseButton = (typeof MOUSE_BUTTONS)[number];

export const SESSION_STATES = [
  'starting',
  'idle',
  'running',
  'awaiting_permission',
  'closed',
  'error',
] as const;
export type SessionState = (typeof SESSION_STATES)[number];
