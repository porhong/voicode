import type { Command } from 'commander';
import pc from 'picocolors';
import { addProject, loadConfig, saveConfig } from '../../config/config.js';
import { resolvePaths, type AgentPaths } from '../../config/paths.js';
import { AgentNotRunningError, controlRequest } from '../../ipc/control.js';
import { loadOrInit } from '../shared.js';
import { ok, out } from '../ui.js';

/** Tells a running agent to re-read the allow-list; a no-op when none is running. */
async function applyToRunningAgent(paths: AgentPaths): Promise<void> {
  try {
    await controlRequest(paths, 'POST', '/projects/reload');
    out(pc.dim('  Applied to the running agent.'));
  } catch (err) {
    if (!(err instanceof AgentNotRunningError)) throw err;
  }
}

export function registerProjects(program: Command): void {
  const projects = program
    .command('projects')
    .description('Manage the directories Claude may work in');

  projects
    .command('list', { isDefault: true })
    .description('List allowed project directories')
    .action(async () => {
      const config = await loadConfig(resolvePaths().config);
      if (!config?.projects.length) {
        return out('No projects. Add one with `voicecode-agent projects add <dir>`.');
      }
      for (const p of config.projects) out(`${pc.bold(p.name)}  ${p.path}  ${pc.dim(p.id)}`);
    });

  projects
    .command('add <dir>')
    .description('Allow Claude to work in a directory')
    .option('-n, --name <name>', 'display name')
    .action(async (dir: string, opts: { name?: string }) => {
      const paths = resolvePaths();
      const { config } = await loadOrInit(paths);
      const project = await addProject(config, dir, opts.name);
      await saveConfig(paths.config, config);
      out(ok(`Allowed ${project.path}`));
      await applyToRunningAgent(paths);
    });

  projects
    .command('remove <nameOrId>')
    .description('Stop allowing a directory (running sessions are not interrupted)')
    .action(async (key: string) => {
      const paths = resolvePaths();
      const { config } = await loadOrInit(paths);
      const before = config.projects.length;
      config.projects = config.projects.filter((p) => p.id !== key && p.name !== key);
      if (config.projects.length === before) throw new Error(`No project named ${key}`);
      await saveConfig(paths.config, config);
      out(ok(`Removed ${key}`));
      await applyToRunningAgent(paths);
    });
}
