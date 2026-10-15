#!/usr/bin/env node
import { Command } from 'commander';
import { VERSION } from '../util/version.js';
import { registerCleanup } from './commands/cleanup.js';
import { registerDevices, registerPair } from './commands/devices.js';
import { registerHook } from './commands/hook.js';
import { registerInit } from './commands/init.js';
import { registerProjects, registerRoots } from './commands/projects.js';
import { registerStart } from './commands/start.js';
import { registerStatus } from './commands/status.js';
import { registerSystem } from './commands/system.js';
import { registerTunnel } from './commands/tunnel.js';
import { fail, out } from './ui.js';

const program = new Command()
  .name('voicecode-agent')
  .description(
    'Voice-controlled Claude Code and desktop mouse control from any browser on your LAN',
  )
  .version(VERSION);

registerInit(program);
registerStart(program);
registerStatus(program);
registerPair(program);
registerDevices(program);
registerProjects(program);
registerRoots(program);
registerTunnel(program);
registerSystem(program);
registerCleanup(program);
registerHook(program);

program.parseAsync().catch((err: unknown) => {
  out(fail((err as Error).message));
  if (process.env.VOICECODE_DEBUG) console.error(err);
  process.exitCode = 1;
});
