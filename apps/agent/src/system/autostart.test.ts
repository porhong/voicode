import { describe, expect, it } from 'vitest';
import { desktopEntry, windowsLauncher } from './autostart.js';

describe('autostart entries', () => {
  it('builds a hidden VBScript launcher with doubled quotes', () => {
    const vbs = windowsLauncher([
      'C:\\Program Files\\nodejs\\node.exe',
      'C:\\Users\\me\\npm\\node_modules\\voicecode-agent\\dist\\cli.js',
    ]);
    expect(vbs).toContain(
      'Run """C:\\Program Files\\nodejs\\node.exe"" ""C:\\Users\\me\\npm\\node_modules\\voicecode-agent\\dist\\cli.js"" start --no-qr", 0, False',
    );
    expect(vbs.split('\r\n').length).toBeGreaterThan(2);
  });

  it('passes VOICECODE_HOME through cmd.exe when set', () => {
    const vbs = windowsLauncher(['C:\\node.exe', 'C:\\cli.js'], 'D:\\vc home');
    expect(vbs).toContain('cmd.exe /c set ""VOICECODE_HOME=D:\\vc home"" && ""C:\\node.exe""');
  });

  it('builds an XDG autostart entry with spec-compliant quoting', () => {
    const entry = desktopEntry(['/usr/bin/node', '/opt/my $app/dist/cli.js'], '/home/me/.vc');
    expect(entry).toContain('[Desktop Entry]');
    expect(entry).toContain(
      'Exec=env "VOICECODE_HOME=/home/me/.vc" "/usr/bin/node" "/opt/my \\$app/dist/cli.js" start --no-qr',
    );
    expect(entry).toContain('Terminal=false');
  });

  it('launches a standalone executable directly', () => {
    expect(windowsLauncher(['C:\\Tools\\voicecode-agent.exe'])).toContain(
      'Run """C:\\Tools\\voicecode-agent.exe"" start --no-qr", 0, False',
    );
    expect(desktopEntry(['/home/me/bin/voicecode-agent'])).toContain(
      'Exec="/home/me/bin/voicecode-agent" start --no-qr',
    );
  });
});
