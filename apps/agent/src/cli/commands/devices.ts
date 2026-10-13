import type { Command } from 'commander';
import pc from 'picocolors';
import { resolvePaths, type AgentPaths } from '../../config/paths.js';
import { AgentNotRunningError, controlRequest } from '../../ipc/control.js';
import { DeviceRegistry, type PublicDevice } from '../../pairing/device-registry.js';
import { minutesUntil, ok, out, printQr } from '../ui.js';

export function registerPair(program: Command): void {
  program
    .command('pair')
    .description('Generate a new device pairing code on the running agent')
    .action(async () => {
      const res = await controlRequest<{
        code: string;
        raw: string;
        expiresAt: number;
        url: string;
      }>(resolvePaths(), 'POST', '/pair');
      out(
        `Pairing code ${pc.bold(res.code)} ${pc.dim(`(expires in ${minutesUntil(res.expiresAt)} min)`)}`,
      );
      await printQr(`${res.url}/#pair=${res.raw}`);
      out(pc.dim(`  ${res.url}`));
    });
}

export function registerDevices(program: Command): void {
  const devices = program.command('devices').description('Show or revoke paired devices');

  devices
    .command('list', { isDefault: true })
    .description('List paired devices')
    .action(async () => {
      const paths = resolvePaths();
      let list: PublicDevice[];
      let online = new Set<string>();
      try {
        const res = await controlRequest<{ devices: PublicDevice[]; online: string[] }>(
          paths,
          'GET',
          '/devices',
        );
        list = res.devices;
        online = new Set(res.online);
      } catch (err) {
        if (!(err instanceof AgentNotRunningError)) throw err;
        list = (await DeviceRegistry.open(paths.devices)).list();
      }
      if (!list.length) {
        return out('No paired devices. Pair one with the code shown by `voicecode-agent start`.');
      }
      for (const d of list) {
        const seen = d.lastSeenAt ? new Date(d.lastSeenAt).toLocaleString() : 'never';
        out(
          `${online.has(d.id) ? ok('●') : pc.dim('○')} ${pc.bold(d.name)}  ${pc.dim(d.id.slice(0, 8))}  last seen ${seen}`,
        );
      }
    });

  devices
    .command('revoke <id>')
    .description('Revoke a device by id prefix, or "all"')
    .action(async (id: string) => {
      const paths = resolvePaths();
      try {
        const res = await controlRequest<{ revoked: number }>(paths, 'POST', '/devices/revoke', {
          id,
        });
        out(ok(`Revoked ${res.revoked} device(s)`));
      } catch (err) {
        if (!(err instanceof AgentNotRunningError)) throw err;
        await revokeOffline(paths, id);
      }
    });
}

/** Edits the device store directly when no agent is running. */
async function revokeOffline(paths: AgentPaths, id: string): Promise<void> {
  const registry = await DeviceRegistry.open(paths.devices);
  if (id === 'all') return out(ok(`Revoked ${await registry.revokeAll()} device(s)`));
  const match = registry.list().filter((d) => d.id.startsWith(id));
  if (match.length !== 1) throw new Error(match.length ? 'Ambiguous device id' : 'No such device');
  await registry.revoke(match[0]!.id);
  out(ok(`Revoked ${match[0]!.name}`));
}
