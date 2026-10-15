import type { Command } from 'commander';
import pc from 'picocolors';
import { loadConfig, saveConfig } from '../../config/config.js';
import { resolvePaths, type AgentPaths } from '../../config/paths.js';
import { AgentNotRunningError, controlRequest } from '../../ipc/control.js';
import { loadOrInit } from '../shared.js';
import { ok, out, warn } from '../ui.js';

/** Tells a running agent to re-read the setting; a no-op when none is running. */
async function applyToRunningAgent(paths: AgentPaths): Promise<void> {
  try {
    await controlRequest(paths, 'POST', '/modes/reload');
    out(pc.dim('  Applied to the running agent.'));
  } catch (err) {
    if (!(err instanceof AgentNotRunningError)) throw err;
  }
}

/**
 * `voicecode-agent modes`: whether phones may switch Claude into the permission modes
 * that skip approvals (bypass permissions, auto, don't ask). Off by default, and only
 * this command on the PC can turn it on: a paired phone (or anyone with the tunnel link
 * and a pairing code) must not be able to give itself unrestricted command execution.
 */
export function registerModes(program: Command): void {
  const modes = program
    .command('modes')
    .description('Allow or forbid permission modes that skip approvals (bypass, auto)');

  modes
    .command('status', { isDefault: true })
    .description('Show which permission modes phones may choose')
    .action(async () => {
      const config = await loadConfig(resolvePaths().config);
      const allowed = config?.claude.allowUnsafeModes === true;
      out(
        allowed
          ? warn('● Unsafe modes allowed: phones can choose bypass permissions, auto and don’t ask')
          : ok('● Safe modes only: manual, accept edits and plan'),
      );
      out(
        pc.dim(
          allowed
            ? '  Turn off with `voicecode-agent modes safe-only`.'
            : '  Allow the others with `voicecode-agent modes allow-unsafe`.',
        ),
      );
    });

  modes
    .command('allow-unsafe')
    .description('Let phones switch to bypass permissions, auto and don’t ask')
    .action(async () => {
      const paths = resolvePaths();
      const { config } = await loadOrInit(paths);
      config.claude.allowUnsafeModes = true;
      await saveConfig(paths.config, config);
      out(warn('Unsafe modes allowed.'));
      out(
        '  In bypass permissions Claude runs every command without asking the phone. Anyone\n' +
          '  with a paired device can choose it, so keep pairing codes and the tunnel link private.\n' +
          '  Sessions started before this keep their modes until restarted for bypass.',
      );
      await applyToRunningAgent(paths);
    });

  modes
    .command('safe-only')
    .description('Only manual, accept edits and plan (sessions in other modes go back to manual)')
    .action(async () => {
      const paths = resolvePaths();
      const { config } = await loadOrInit(paths);
      config.claude.allowUnsafeModes = false;
      await saveConfig(paths.config, config);
      out(ok('Safe modes only.'));
      await applyToRunningAgent(paths);
    });
}
