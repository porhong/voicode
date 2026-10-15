/**
 * Bump when a change to the wire format is not backwards compatible.
 * The agent rejects clients that speak a different major version.
 */
export const PROTOCOL_VERSION = 4;

/**
 * Claude Code's reasoning effort levels, lowest first (`--effort`, the SDK's `effort`).
 * Not every model takes every level; `max` is never saved, only used for a session.
 */
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

/**
 * Claude Code's permission modes. `default` asks for every tool that needs permission
 * (the CLI calls it "manual"). The last three skip approvals and are only offered when
 * the PC allows them (`voicecode-agent modes allow-unsafe`).
 */
export const PERMISSION_MODES = [
  'default',
  'acceptEdits',
  'plan',
  'auto',
  'dontAsk',
  'bypassPermissions',
] as const;
export type PermissionModeName = (typeof PERMISSION_MODES)[number];
export const UNSAFE_PERMISSION_MODES: readonly PermissionModeName[] = [
  'auto',
  'dontAsk',
  'bypassPermissions',
];

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
  /** Max length of a folder path sent by a device. */
  maxPathLength: 4096,
  /** Max audio a device may stream per second, in bytes (2× real time for 16 kHz s16). */
  maxAudioBytesPerSecond: 64_000,
  /** Max characters of raw terminal input per message. */
  maxTerminalInput: 4096,
  /** Max size of one image uploaded for Claude (the phone shrinks photos well below it). */
  maxAttachmentBytes: 10 * 1024 * 1024,
  /** Max images sent with one prompt. */
  maxAttachments: 4,
} as const;

/**
 * Microphone audio from a device is streamed as binary WebSocket frames while the
 * device holds the microphone lease (`voice.mic.start`). Every frame is raw PCM in
 * this format, so the agent can play it straight into a virtual microphone without a
 * codec: signed 16-bit little-endian, mono, 16 kHz. A frame holds whole samples; 100 ms
 * (3 200 bytes) is the intended size.
 */
export const AUDIO = {
  sampleRate: 16_000,
  channels: 1,
  bytesPerSample: 2,
  /** Longest single frame accepted. */
  maxFrameMs: 1_000,
} as const;

export const MOUSE_BUTTONS = ['left', 'right', 'middle'] as const;
export type MouseButton = (typeof MOUSE_BUTTONS)[number];

/** Claude Code's dictation in a voice session, as the agent sees it on the terminal. */
export const VOICE_STATES = [
  'off',
  'idle',
  'starting',
  'recording',
  'finalizing',
  'error',
] as const;
export type VoiceState = (typeof VOICE_STATES)[number];

export const SESSION_STATES = [
  'starting',
  'idle',
  'running',
  'awaiting_permission',
  'closed',
  'error',
] as const;
export type SessionState = (typeof SESSION_STATES)[number];

/**
 * Disposable files the agent keeps on the PC, in the order cleanup removes them:
 * leftovers of interrupted writes and downloads, Claude Code versions this build no
 * longer uses, runtimes extracted by older standalone builds, and the rotated log.
 */
export const STORAGE_CATEGORIES = ['temp', 'attachments', 'downloads', 'runtime', 'logs'] as const;
export type StorageCategory = (typeof STORAGE_CATEGORIES)[number];

/** Bounds for the automatic cleanup limit, in MB. */
export const STORAGE_LIMIT_MB = { min: 50, max: 100_000, default: 250 } as const;
