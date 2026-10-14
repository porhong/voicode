import type { Command } from 'commander';
import pc from 'picocolors';
import { addProject, saveConfig } from '../../config/config.js';
import { resolvePaths } from '../../config/paths.js';
import { runChecks } from '../../doctor/checks.js';
import { ensureControlToken } from '../../ipc/control.js';
import { ensureTls } from '../../tls/certificates.js';
import { silentLogger } from '../../util/logger.js';
import { lanAddresses } from '../../util/network.js';
import { VERSION } from '../../util/version.js';
import {
  loadOrInit,
  parsePort,
  prepareClaudeCode,
  setUpWorkspace,
  warnAboutAutoApprovals,
} from '../shared.js';
import { heading, ok, out, printChecks, row, warn } from '../ui.js';

export function registerInit(program: Command): void {
  program
    .command('init')
    .description('Create config, local certificate authority and server certificate')
    .option('-p, --project <dir>', 'add a project directory Claude may work in')
    .option('-r, --root <dir>', 'add a workspace folder: any folder inside it may be opened')
    .option('--port <port>', 'HTTPS port', parsePort)
    .option('--host <address>', 'bind address (default 0.0.0.0)')
    .option('--regenerate-ca', 'create a new CA (all phones must re-install it)')
    .action(
      async (opts: {
        project?: string;
        root?: string;
        port?: number;
        host?: string;
        regenerateCa?: boolean;
      }) => {
        const paths = resolvePaths();
        const { config, created } = await loadOrInit(paths);
        if (opts.port) config.server.port = opts.port;
        if (opts.host) config.server.host = opts.host;
        if (opts.project)
          await warnAboutAutoApprovals((await addProject(config, opts.project)).path);
        await setUpWorkspace(config, opts.root);
        await saveConfig(paths.config, config);
        await ensureControlToken(paths);

        const tls = await ensureTls(
          paths,
          lanAddresses().map((a) => a.address),
          silentLogger(),
          { forceCa: opts.regenerateCa },
        );

        heading('VoiceCode Agent', VERSION);
        out(created ? ok('  Initialized') : ok('  Updated'));
        await prepareClaudeCode();
        row('Config', paths.config);
        row('Projects', config.projects.map((p) => p.path).join(', ') || pc.dim('none yet'));
        row('Workspace', config.roots.join(', ') || warn('none — add one with --root <dir>'));
        row('CA SHA-256', tls.caFingerprint);
        out();
        printChecks(await runChecks(config, paths));
        out();
        out(`  Next: run ${pc.bold('voicecode-agent')} from any terminal to start the agent.`);
      },
    );
}
