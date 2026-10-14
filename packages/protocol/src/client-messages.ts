import { z } from 'zod';
import { AUDIO, LIMITS, MOUSE_BUTTONS } from './constants.js';

const delta = (max: number) => z.number().int().min(-max).max(max);
const id = z.string().min(1).max(128);

export const MouseButtonSchema = z.enum(MOUSE_BUTTONS);

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
  z.object({ type: z.literal('voice.session.start'), projectId: id, resume: id.optional() }),
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
  }),
  z.object({ type: z.literal('claude.session.subscribe'), sessionId: id }),
  z.object({ type: z.literal('claude.session.close'), sessionId: id }),
  z.object({ type: z.literal('claude.sessions.history'), projectId: id }),
  z.object({
    type: z.literal('claude.prompt'),
    sessionId: id,
    text: z.string().trim().min(1).max(LIMITS.maxPromptLength),
  }),
  z.object({ type: z.literal('claude.interrupt'), sessionId: id }),
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
   * Take control of a PC session: the agent attaches to its console, so the phone's
   * dictation, prompts and keys go to the Claude Code already running in the terminal.
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
