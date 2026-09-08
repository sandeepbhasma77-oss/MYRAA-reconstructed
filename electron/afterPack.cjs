'use strict';

const fs = require('fs');
const path = require('path');

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;

  const { execFile } = require('child_process');
  const { promisify } = require('util');
  const execFileAsync = promisify(execFile);

  const productName = context.packager.appInfo.productFilename;
  const primaryExe = path.join(context.appOutDir, productName + '.exe');
  const runtimeExe = path.join(context.appOutDir, productName + '-runtime.exe');
  const launcherExe = path.join(__dirname, '..', 'build', 'MYRAA-launcher.exe');

  if (!fs.existsSync(primaryExe)) throw new Error('Packaged Electron runtime is missing: ' + primaryExe);

  // Unsigned-sandbox builds set win.signAndEditExecutable=false (winCodeSign
  // needs symlink privilege). Re-apply the exact version metadata + icon that
  // electron-builder would stamp with rcedit, so the exe matches the original.
  await stampVersionInfo(primaryExe, execFileAsync).catch((err) => {
    console.warn('[afterPack] rcedit stamp skipped: ' + (err && err.message));
  });

  if (!fs.existsSync(launcherExe)) {
    // Reconstruction build without .NET: keep the Electron exe as-is.
    // With `dotnet build electron/launcher.csproj` the launcher swap runs as in the original.
    console.warn('[afterPack] MYRAA-launcher.exe not found, skipping launcher swap: ' + launcherExe);
    return;
  }

  await fs.promises.copyFile(primaryExe, runtimeExe);
  await fs.promises.copyFile(launcherExe, primaryExe);
};

// Best-effort locate of rcedit-x64.exe (electron-builder tool cache).
function findRcedit() {
  const candidates = [];
  const cacheRoot = path.join(
    process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Local'),
    'electron-builder',
    'Cache',
    'winCodeSign',
  );
  try {
    for (const dir of fs.readdirSync(cacheRoot)) {
      candidates.push(path.join(cacheRoot, dir, 'rcedit-x64.exe'));
    }
  } catch { /* no cache */ }
  candidates.push(
    path.join(__dirname, '..', 'node_modules', 'rcedit', 'bin', 'rcedit-x64.exe'),
  );
  return candidates.find((p) => { try { return fs.existsSync(p); } catch { return false; } }) || null;
}

async function stampVersionInfo(exePath, execFileAsync) {
  const rcedit = findRcedit();
  if (!rcedit) throw new Error('no rcedit-x64.exe available');
  const icon = path.join(__dirname, '..', 'build', 'icon.ico');
  const description = 'MYRAA - a private 3D AI desktop companion powered by each user\'s own Gemini API key.';
  const args = [
    exePath,
    '--set-file-version', '1.0.0',
    '--set-product-version', '1.0.0',
    '--set-version-string', 'CompanyName', 'MYRAA',
    '--set-version-string', 'FileDescription', description,
    '--set-version-string', 'ProductName', 'MYRAA',
    '--set-version-string', 'InternalName', 'MYRAA',
    '--set-version-string', 'LegalCopyright', 'Copyright \u00a9 2026 MYRAA',
    '--set-version-string', 'OriginalFilename', 'MYRAA.exe',
  ];
  if (fs.existsSync(icon)) args.push('--set-icon', icon);
  await execFileAsync(rcedit, args);
  console.log('[afterPack] version info + icon stamped on ' + exePath);
}
