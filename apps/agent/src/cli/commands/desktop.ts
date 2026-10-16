import type { Command } from 'commander';
import pc from 'picocolors';
import { loadConfig } from '../../config/config.js';
import { resolvePaths } from '../../config/paths.js';
import { hookCommandLine } from '../../claude/pty-session.js';
import {
  claudeSettingsFile,
  desktopHookInstalled,
  installDesktopHook,
  removeDesktopHook,
} from '../../desktop/approval-hook.js';
import { desktopControlStatus } from '../../desktop/desktop-helper.js';
import { ok, out, warn } from '../ui.js';

/** Default approval timeout (15 min) when no config exists yet. */
const DEFAULT_APPROVAL_TIMEOUT_MS = 15 * 60_000;

/**
 * `voicecode-agent desktop`: lets the phone take control of Claude Desktop sessions.
 * Prompts go through Desktop's window; approvals through a `PermissionRequest` hook in
 * the user's Claude Code settings, which only `enable` adds (and `disable` removes),
 * since it touches every Claude Code session on the PC: for the ones the phone does not
 * control it decides nothing.
 */
export function registerDesktop(program: Command): void {
  const desktop = program
    .command('desktop')
    .description('Let the phone take control of Claude Desktop sessions (Windows)');

  desktop
    .command('status', { isDefault: true })
    .description('Show whether Claude Desktop sessions can be controlled from the phone')
    .action(() => {
      const helper = desktopControlStatus();
      const hook = desktopHookInstalled();
      if (helper.available && hook) {
        out(ok('● Claude Desktop control is on'));
      } else if (!helper.available) {
        out(warn(`○ Unavailable: ${helper.reason ?? 'unknown reason'}`));
      } else {
        out(warn('○ Off: phone approvals for Claude Desktop are not set up'));
        out(pc.dim('  Turn on with `voicecode-agent desktop enable`.'));
      }
      out(pc.dim(`  Approval hook: ${hook ? 'in' : 'not in'} ${claudeSettingsFile()}`));
    });

  desktop
    .command('enable')
    .description('Add the approval hook to your Claude Code settings')
    .action(async () => {
      const helper = desktopControlStatus();
      if (!helper.available) {
        out(warn(`Claude Desktop control is not available here: ${helper.reason}`));
        process.exitCode = 1;
        return;
      }
      const config = await loadConfig(resolvePaths().config);
      const timeoutMs = config?.claude.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
      // Longer than the phone's own deadline, so the agent (not the hook) times out first.
      await installDesktopHook(
        hookCommandLine('permission-request'),
        Math.ceil(timeoutMs / 1000) + 30,
      );
      out(ok('Claude Desktop control is on.'));
      out(
        `  Added a PermissionRequest hook to ${claudeSettingsFile()}.\n` +
          '  For a Claude Desktop session you take control of from the phone, its permission\n' +
          '  requests come to the phone (whichever answers first, the PC or the phone, wins).\n' +
          '  Every other Claude Code session ignores it. Remove it with `voicecode-agent desktop disable`.',
      );
    });

  desktop
    .command('disable')
    .description('Remove the approval hook from your Claude Code settings')
    .action(async () => {
      const removed = await removeDesktopHook();
      out(removed ? ok('Claude Desktop control is off.') : pc.dim('The hook was not set up.'));
    });
}
