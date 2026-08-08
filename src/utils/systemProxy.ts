import { execSync } from 'child_process';

function getRegistryValue(path: string, name: string): string | null {
  try {
    const output = execSync(`reg query "${path}" /v "${name}" 2>&1`, { encoding: 'utf-8' });
    const match = output.match(/\s+([^\s]+)\s+REG_[A-Z_]+\s+(.+)/);
    if (match) return match[2].trim();
  } catch {}
  return null;
}

export function getSystemProxy(): string | null {
  if (process.platform !== 'win32') return null;

  const proxyEnable = getRegistryValue('HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings', 'ProxyEnable');
  if (!proxyEnable || proxyEnable === '0x0') return null;

  const proxyServer = getRegistryValue('HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings', 'ProxyServer');
  if (!proxyServer) return null;

  const trimmed = proxyServer.trim();
  if (!trimmed) return null;

  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `http://${trimmed}`;
}

export function getProxyArg(): string | null {
  const envProxy = process.env.HTTP_PROXY || process.env.HTTPS_PROXY;
  if (envProxy) return envProxy;

  const systemProxy = getSystemProxy();
  if (systemProxy) return systemProxy;

  return null;
}
