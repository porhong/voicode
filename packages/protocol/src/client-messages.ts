import { z } from 'zod';
import { LIMITS, MOUSE_BUTTONS } from './constants.js';

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
