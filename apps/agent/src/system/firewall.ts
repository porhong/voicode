import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export const FIREWALL_RULE_NAME = 'VoiceCode Agent';

export interface FirewallState {
  /** The rule exists and allows the configured port. */
  ruleOk: boolean;
  /** Ports allowed by an existing rule with our name, if any. */
  rulePorts: string[];
  /** Network categories of the active connections (Public networks block the rule). */
  networkCategories: string[];
}

async function powershell(script: string, timeout = 15_000): Promise<string> {
  const { stdout } = await run(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    { timeout, windowsHide: true },
  );
  return stdout.trim();
}

/**
 * Inspects Windows Defender Firewall through the NetSecurity cmdlets, which (unlike
 * `netsh` output) are not localized. Reading rules needs no elevation.
 */
export async function inspectWindowsFirewall(port: number): Promise<FirewallState> {
  const output = await powershell(
    [
      `$r = Get-NetFirewallRule -DisplayName '${FIREWALL_RULE_NAME}' -ErrorAction SilentlyContinue | Where-Object { $_.Enabled -eq 'True' -and $_.Direction -eq 'Inbound' -and $_.Action -eq 'Allow' }`,
      `$ports = @($r | Get-NetFirewallPortFilter | ForEach-Object { $_.LocalPort })`,
      `$cats = @(Get-NetConnectionProfile -ErrorAction SilentlyContinue | ForEach-Object { [string]$_.NetworkCategory })`,
      `@{ ports = $ports; categories = $cats } | ConvertTo-Json -Compress`,
    ].join('; '),
  );
  const parsed = JSON.parse(output || '{}') as { ports?: unknown; categories?: unknown };
  const asList = (v: unknown) => (Array.isArray(v) ? v : v == null ? [] : [v]).map(String);
  const rulePorts = asList(parsed.ports);
  return {
    ruleOk: rulePorts.some((p) => p === String(port) || p === 'Any'),
    rulePorts,
    networkCategories: asList(parsed.categories),
  };
}

/**
 * Creates (or replaces) an inbound allow rule for the agent's TCP port on Private and
 * Domain networks. Opens a UAC prompt, since changing firewall rules needs admin.
 */
export async function allowThroughWindowsFirewall(port: number): Promise<void> {
  const inner = [
    `Remove-NetFirewallRule -DisplayName '${FIREWALL_RULE_NAME}' -ErrorAction SilentlyContinue`,
    `New-NetFirewallRule -DisplayName '${FIREWALL_RULE_NAME}' -Description 'Inbound HTTPS for voicecode-agent' -Direction Inbound -Protocol TCP -LocalPort ${port} -Profile Private,Domain -Action Allow | Out-Null`,
  ].join('; ');
  const encoded = Buffer.from(inner, 'utf16le').toString('base64');
  await powershell(
    `Start-Process powershell.exe -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand','${encoded}'`,
    120_000,
  );
}
