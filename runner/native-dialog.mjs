import { spawn } from 'node:child_process';

const POWERSHELL_ARGS = ['-NoLogo', '-NoProfile', '-STA', '-WindowStyle', 'Hidden', '-Command'];
const MESSAGE_SCRIPT = [
  'Add-Type -AssemblyName System.Windows.Forms',
  '[System.Windows.Forms.Application]::EnableVisualStyles()',
  '[System.Windows.Forms.MessageBox]::Show($env:MILLENNIUM_DIALOG_TEXT, $env:MILLENNIUM_DIALOG_TITLE, [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Information) | Out-Null',
].join('; ');

// This module intentionally provides error messages only. Starting work is authorized by
// the paired page's explicit Start click; there is no second native approval dialog.
export async function showConnectorMessage(text, title = 'Millennium Connector') {
  if (process.platform !== 'win32') return;
  await runDialog(MESSAGE_SCRIPT, safeDialogText(text, 1_800), safeDialogText(title, 100));
}

function safeDialogText(value, max) {
  return [...String(value ?? '')]
    .filter((character) => {
      const code = character.charCodeAt(0);
      return (code >= 32 && code !== 127 && !(code >= 0x202a && code <= 0x202e) && !(code >= 0x2066 && code <= 0x2069))
        || code === 9 || code === 10 || code === 13;
    })
    .join('')
    .trim()
    .slice(0, max);
}

function runDialog(script, text, title) {
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(code);
    };
    const child = spawn('powershell.exe', [...POWERSHELL_ARGS, script], {
      env: { ...process.env, MILLENNIUM_DIALOG_TEXT: text, MILLENNIUM_DIALOG_TITLE: title },
      stdio: 'ignore',
      windowsHide: true,
    });
    timer = setTimeout(() => {
      try { child.kill(); } catch { /* already closed */ }
      finish(-1);
    }, 120_000);
    timer.unref?.();
    child.once('error', () => finish(-1));
    child.once('exit', (code) => finish(code ?? -1));
  });
}
