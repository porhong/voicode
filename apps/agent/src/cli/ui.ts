import os from 'node:os';
import pc from 'picocolors';
import qrcode from 'qrcode-terminal';
import type { CheckResult } from '../doctor/checks.js';

/** Strips control/format characters from untrusted text (e.g. device names) before printing. */
export function clean(text: string): string {
  return text.replace(/[\p{Cc}\p{Cf}]/gu, '');
}

export function out(line = ''): void {
  process.stdout.write(`${line}\n`);
}

export function heading(title: string, version: string): void {
  out();
  out(`${pc.bold(title)}  ${pc.dim(`v${version}`)}`);
}

export function row(label: string, value: string): void {
  out(`  ${pc.dim(label.padEnd(14))}${value}`);
}

export function ok(text: string): string {
  return pc.green(text);
}
export function warn(text: string): string {
  return pc.yellow(text);
}
export function fail(text: string): string {
  return pc.red(text);
}

export function platformName(): string {
  if (process.platform === 'win32') {
    const build = Number(os.release().split('.')[2] ?? 0);
    return `Windows ${build >= 22000 ? '11' : '10'} (build ${build})`;
  }
  return `${os.type()} ${os.release()}`;
}

export function printQr(text: string): Promise<void> {
  return new Promise((resolve) =>
    qrcode.generate(text, { small: true }, (qr) => {
      out(qr.replace(/^/gm, '  '));
      resolve();
    }),
  );
}

export function printChecks(results: CheckResult[]): void {
  const icon = { ok: ok('✔'), warn: warn('!'), fail: fail('✖') } as const;
  for (const r of results) {
    out(`  ${icon[r.status]} ${r.name.padEnd(22)} ${r.detail}`);
    if (r.fix && r.status !== 'ok') out(`    ${pc.dim('→')} ${pc.dim(r.fix)}`);
  }
}

export function timestamp(): string {
  return pc.dim(new Date().toLocaleTimeString());
}

export function minutesUntil(epochMs: number): number {
  return Math.max(0, Math.round((epochMs - Date.now()) / 60_000));
}
