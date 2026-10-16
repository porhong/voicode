import { z } from 'zod';
import {
  AUDIO,
  EFFORT_LEVELS,
  LIMITS,
  MOUSE_BUTTONS,
  PERMISSION_MODES,
  STORAGE_LIMIT_MB,
} from './constants.js';

const delta = (max: number) => z.number().int().min(-max).max(max);
const id = z.string().min(1).max(128);
/**
 * A model alias or id (`opus`, `claude-sonnet-5-5`, `claude-opus-5-5[1m]`). Restricted to
 * these characters because terminal sessions receive it as typed text (`/model …`).
 */
export const ModelNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,99}$/, 'not a model name');

export const MouseButtonSchema = z.enum(MOUSE_BUTTONS);
export const EffortSchema = z.enum(EFFORT_LEVELS);

/**
 * Messages a browser client may send to the agent over the WebSocket.
 * Every message is validated with this schema before it is dispatched; anything
 * that fails validation is answered with an `error` and otherwise ignored.
 */
export const ClientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ping'), t: z.number() }),

  // --- Mouse control -------------------------------------------------------
  z.object({ type: z.literal('mouse.acquire'), force: z.boolean().optional() }),
  z.object({ type: z.literal('mouse.release') }),
  z.object({
    type: z.literal('mouse.move'),
    dx: delta(LIMITS.maxMouseDelta),
    dy: delta(LIMITS.maxMouseDelta),
  }),
  z.object({ type: z.literal('mouse.button.down'), button: MouseButtonSchema }),
  z.object({ type: z.literal('mouse.button.up'), button: MouseButtonSchema }),
  z.object({
    type: z.literal('mouse.click'),
    button: MouseButtonSchema,
    count: z.union([z.literal(1), z.literal(2)]).optional(),
  }),
  z.object({
    type: z.literal('mouse.scroll'),
    dx: delta(LIMITS.maxScrollDelta),
    dy: delta(LIMITS.maxScrollDelta),
  }),
  z.object({ type: z.literal('mouse.position') }),

  // --- Microphone (phone mic → virtual microphone on the PC) ---------------
  /**
   * Take the microphone lease; audio then follows as binary frames (see `AUDIO`). The
   * sample rate is fixed so the agent never has to resample; it is sent so a client
   * built against another format is refused rather than played back garbled.
   */
  z.object({ type: z.literal('voice.mic.start'), sampleRate: z.literal(AUDIO.sampleRate) }),
  z.object({ type: z.literal('voice.mic.stop') }),
  /**
   * Start an interactive Claude Code session on the PC (in a pseudo-terminal) whose
   * dictation is driven from here: the phone's microphone and push-to-talk.
   */
  z.object({
    type: z.literal('voice.session.start'),
    projectId: id,
    resume: id.optional(),
    model: ModelNameSchema.optional(),
    effort: EffortSchema.optional(),
  }),
  /** Push-to-talk for a voice session: press taps the dictation key, release sends. */
  z.object({ type: z.literal('voice.ptt'), sessionId: id, pressed: z.boolean() }),

  // --- Terminal of a voice session ---------------------------------------
  z.object({
    type: z.literal('terminal.subscribe'),
    sessionId: id,
    cols: z.number().int().min(20).max(400),
    rows: z.number().int().min(5).max(200),
  }),
  z.object({ type: z.literal('terminal.unsubscribe') }),
  z.object({
    type: z.literal('terminal.input'),
    sessionId: id,
    data: z.string().min(1).max(LIMITS.maxTerminalInput),
  }),
  z.object({
    type: z.literal('terminal.resize'),
    sessionId: id,
    cols: z.number().int().min(20).max(400),
    rows: z.number().int().min(5).max(200),
  }),

  // --- Claude Code ---------------------------------------------------------
  z.object({
    type: z.literal('claude.session.start'),
    projectId: id,
    /** Resume an earlier Claude Code session by its SDK session id. */
    resume: id.optional(),
    /** Model for this session; the PC's default when omitted. */
    model: ModelNameSchema.optional(),
    /** Reasoning effort for this session; the model's default when omitted. */
    effort: EffortSchema.optional(),
  }),
  z.object({ type: z.literal('claude.session.subscribe'), sessionId: id }),
  z.object({ type: z.literal('claude.session.close'), sessionId: id }),
  z.object({ type: z.literal('claude.sessions.history'), projectId: id }),
  z
    .object({
      type: z.literal('claude.prompt'),
      sessionId: id,
      text: z.string().trim().max(LIMITS.maxPromptLength),
      /** Images uploaded with `POST /api/attachments`, by the ids it returned. */
      attachments: z
        .array(z.string().regex(/^[0-9a-f]{32}$/))
        .max(LIMITS.maxAttachments)
        .optional(),
    })
    .refine((m) => m.text.length > 0 || (m.attachments?.length ?? 0) > 0, {
      message: 'A prompt needs text or an image',
    }),
  z.object({ type: z.literal('claude.interrupt'), sessionId: id }),
  /** Switch the model of a session; `null` goes back to the PC's default. */
  z.object({
    type: z.literal('claude.model.set'),
    sessionId: id,
    model: ModelNameSchema.nullable(),
  }),
  /**
   * Change a session's reasoning effort for its next replies; `null` goes back to the
   * model's default. Phone (SDK) sessions only: terminal sessions take it at start.
   */
  z.object({
    type: z.literal('claude.effort.set'),
    sessionId: id,
    effort: EffortSchema.nullable(),
  }),
  /**
   * Switch a session's permission mode (one of `SessionSummary.modes`). The modes that
   * skip approvals are refused unless the PC allows them.
   */
  z.object({
    type: z.literal('claude.mode.set'),
    sessionId: id,
    mode: z.enum(PERMISSION_MODES),
  }),
  /** The models that can be picked (for a session when given, else the general list). */
  z.object({ type: z.literal('claude.models'), sessionId: id.optional() }),
  /**
   * The Claude plan's usage limits (session, weekly, per model, extra usage). The agent
   * caches the answer for a minute; `refresh` asks Claude Code again.
   */
  z.object({ type: z.literal('claude.usage'), refresh: z.boolean().optional() }),
  /** Give a session the name shown on the phone (a controlled terminal session keeps Claude Code's otherwise). */
  z.object({
    type: z.literal('claude.session.rename'),
    sessionId: id,
    title: z.string().trim().min(1).max(80),
  }),
  // --- Disposable files on the PC --------------------------------------------
  /** How much space the agent's caches, old versions and rotated logs take. */
  z.object({ type: z.literal('storage.info') }),
  /** Remove them now (never config, pairing, certificates or the current versions). */
  z.object({ type: z.literal('storage.cleanup') }),
  /** Automatic cleanup once the disposable files pass `maxCacheMb`. */
  z.object({
    type: z.literal('storage.settings'),
    auto: z.boolean(),
    maxCacheMb: z.number().int().min(STORAGE_LIMIT_MB.min).max(STORAGE_LIMIT_MB.max),
  }),
  // --- Workspace roots -------------------------------------------------------
  /** List the subfolders of a folder inside a workspace root (the roots when omitted). */
  z.object({
    type: z.literal('folders.list'),
    path: z.string().min(1).max(LIMITS.maxPathLength).optional(),
  }),
  /** Start a session in a folder inside a workspace root, allowing it as a project. */
  z.object({
    type: z.literal('claude.folder.start'),
    path: z.string().min(1).max(LIMITS.maxPathLength),
  }),
  // --- Claude sessions elsewhere on the PC ---------------------------------
  /** Follow one PC session's transcript (replaces any earlier subscription). */
  z.object({ type: z.literal('pc.session.subscribe'), sessionId: id }),
  z.object({ type: z.literal('pc.session.unsubscribe') }),
  /**
   * Continue an idle PC session from the phone, as a fork so the terminal's own copy is
   * untouched. `allowFolder` confirms adding its folder to the allow-list if needed.
   */
  z.object({
    type: z.literal('pc.session.continue'),
    sessionId: id,
    allowFolder: z.boolean().optional(),
  }),
  /**
   * Take control of a PC session: the agent attaches to its console (terminal) or drives
   * the Claude Desktop window, so the phone's prompts go to the Claude Code already
   * running there and its approvals come to the phone.
   */
  z.object({
    type: z.literal('pc.session.control'),
    sessionId: id,
    allowFolder: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('claude.permission.respond'),
    sessionId: id,
    requestId: id,
    decision: z.enum(['allow', 'deny']),
    /** Allow and also apply Claude's suggested rule for the rest of this session. */
    rememberForSession: z.boolean().optional(),
    message: z.string().max(2000).optional(),
  }),
]);

export type ClientMessage = z.infer<typeof ClientMessageSchema>;
export type ClientMessageType = ClientMessage['type'];
export type ClientMessageOf<T extends ClientMessageType> = Extract<ClientMessage, { type: T }>;
