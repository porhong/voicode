import type { Command } from 'commander';
import pc from 'picocolors';
import { loadConfig } from '../../config/config.js';
import { resolvePaths } from '../../config/paths.js';
import { runChecks } from '../../doctor/checks.js';
import { autostartStatus, disableAutostart, enableAutostart } from '../../system/autostart.js';
import { allowThroughWindowsFirewall, inspectWindowsFirewall } from '../../system/firewall.js';
import { VERSION } from '../../util/version.js';
import { fail, heading, ok, out, printChecks, row, warn } from '../ui.js';

export function registerSystem(program: Command): void {
  const autostart = program
    .command('autostart')
    .description('Start the agent automatically when you log in');

  autostart
    .command('status', { isDefault: true })
    .description('Show whether the agent starts at login')
    .action(async () => {
      const s = await autostartStatus();
      out(s.enabled ? ok('● Starts at login') : pc.dim('○ Does not start at login'));
      row('Entry', s.file);
      if (s.command) row('Command', s.command);
    });

  autostart
    .command('enable')
    .description('Start the agent (hidden, logging to agent.log) at every login')
    .action(async () => {
      const s = await enableAutostart();
      out(ok('Enabled: the agent will start when you log in.'));
      row('Entry', s.file);
      row('Command', s.command ?? '');
      out(
        pc.dim(
          '  It runs without a window; use `voicecode-agent status` and `voicecode-agent pair`.',
        ),
      );
    });

  autostart
    .command('disable')
    .description('Stop starting the agent at login')
    .action(async () => {
      const s = await disableAutostart();
      out(ok('Disabled.'));
      row('Removed', s.file);
    });

  program
    .command('firewall')
    .description('Allow the agent through Windows Defender Firewall (asks for admin)')
    .action(async () => {
      const config = await loadConfig(resolvePaths().config);
      const port = config?.server.port ?? 8443;
      if (process.platform !== 'win32') {
        out('Linux firewalls are not configured automatically. If one is active, allow the port:');
        out(`  ufw:       sudo ufw allow ${port}/tcp`);
        out(
          `  firewalld: sudo firewall-cmd --add-port=${port}/tcp --permanent && sudo firewall-cmd --reload`,
        );
        return;
      }
      const before = await inspectWindowsFirewall(port);
      if (!before.ruleOk) {
        out(`Adding an inbound rule for TCP ${port} — approve the Windows admin prompt…`);
        await allowThroughWindowsFirewall(port);
      }
      const after = await inspectWindowsFirewall(port);
      if (!after.ruleOk) {
        out(fail('The firewall rule was not created (was the admin prompt declined?).'));
        process.exitCode = 1;
        return;
      }
      out(ok(`Inbound TCP ${port} is allowed on Private and Domain networks.`));
      if (after.networkCategories.includes('Public')) {
        out(
          warn(
            '  Your current network is marked Public, where the rule does not apply. If this is\n' +
              '  your home or office network, set it to Private in Settings → Network & internet.',
          ),
        );
      }
    });

  program
    .command('doctor')
    .description('Diagnose OS integrations, Claude Code and network setup')
    .action(async () => {
      const paths = resolvePaths();
      const config = await loadConfig(paths.config);
      heading('VoiceCode Doctor', VERSION);
      out();
      const results = await runChecks(config, paths);
      printChecks(results);
      if (results.some((r) => r.status === 'fail')) process.exitCode = 1;
    });
}
