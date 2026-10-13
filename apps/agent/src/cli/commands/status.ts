import type { Command } from 'commander';
import pc from 'picocolors';
import type { MouseStatus, SessionSummary } from '@voicecode/protocol';
import type { ProjectConfig } from '../../config/config.js';
import { loadConfig } from '../../config/config.js';
import { resolvePaths } from '../../config/paths.js';
import { AgentNotRunningError, controlRequest } from '../../ipc/control.js';
import { listSessions } from '@anthropic-ai/claude-agent-sdk';
import { formatDuration } from '../shared.js';
import { clean, fail, ok, out, row, warn } from '../ui.js';

interface StatusResponse {
  version: string;
  pid: number;
  startedAt: number;
  urls: string[];
  connections: Array<{ deviceName: string }>;
  mouse: MouseStatus;
  sessions: SessionSummary[];
  projects: ProjectConfig[];
}

export function registerStatus(program: Command): void {
  program
    .command('status')
    .description('Show whether the agent is running, its URL, clients and sessions')
    .action(async () => {
      let status: StatusResponse;
      try {
        status = await controlRequest<StatusResponse>(resolvePaths(), 'GET', '/status');
      } catch (err) {
        if (!(err instanceof AgentNotRunningError)) throw err;
        out(`${fail('●')} Not running. Start it with ${pc.bold('voicecode-agent start')}.`);
        process.exitCode = 3;
        return;
      }
      out(`${ok('●')} Running ${pc.dim(`v${status.version}, pid ${status.pid}`)}`);
      row('Uptime', formatDuration(Date.now() - status.startedAt));
      row('URL', status.urls[0] ?? '-');
      row(
        'Clients',
        status.connections.length
          ? status.connections.map((c) => clean(c.deviceName)).join(', ')
          : pc.dim('none'),
      );
      row(
        'Mouse',
        status.mouse.available
          ? `${status.mouse.driver}${status.mouse.holder ? `, controlled by ${clean(status.mouse.holder.deviceName)}` : ''}`
          : warn(`unavailable (${status.mouse.reason ?? 'unknown'})`),
      );
      row('Projects', status.projects.map((p) => p.name).join(', ') || warn('none'));
      row('Sessions', status.sessions.length ? '' : pc.dim('none'));
      for (const s of status.sessions) {
        const project = status.projects.find((p) => p.id === s.projectId)?.name ?? s.projectId;
        out(`    ${s.state.padEnd(20)} ${project}  ${s.title ?? pc.dim('(no prompt yet)')}`);
      }
    });

  program
    .command('sessions')
    .description('List live Claude sessions and recent saved sessions per project')
    .action(async () => {
      const paths = resolvePaths();
      const config = await loadConfig(paths.config);
      try {
        const { sessions } = await controlRequest<{ sessions: SessionSummary[] }>(
          paths,
          'GET',
          '/sessions',
        );
        out(pc.bold('Live sessions'));
        if (!sessions.length) out(pc.dim('  none'));
        for (const s of sessions) {
          const project = config?.projects.find((p) => p.id === s.projectId)?.name ?? s.projectId;
          out(`  ${s.state.padEnd(20)} ${project}  ${s.title ?? pc.dim('(no prompt yet)')}`);
        }
      } catch (err) {
        if (!(err instanceof AgentNotRunningError)) throw err;
        out(pc.dim('Agent is not running; showing saved sessions only.'));
      }
      for (const project of config?.projects ?? []) {
        out();
        out(`${pc.bold(project.name)} ${pc.dim(project.path)}`);
        const recent = await listSessions({ dir: project.path, limit: 10 });
        if (!recent.length) out(pc.dim('  no saved sessions'));
        for (const s of recent) {
          out(
            `  ${pc.dim(new Date(s.lastModified).toLocaleString().padEnd(22))} ${s.customTitle ?? s.summary}`,
          );
        }
      }
    });

  program
    .command('stop')
    .description('Stop the running agent')
    .action(async () => {
      await controlRequest(resolvePaths(), 'POST', '/stop');
      out(ok('Agent is stopping'));
    });
}
