import 'dotenv/config';
import axios from 'axios';
import fs from 'node:fs/promises';
import path from 'node:path';

type TokenCache = {
  accessToken: string;
  refreshToken?: string;
  expiresAtMs: number;
  scope: string;
  tenantId: string;
  clientId: string;
};

type DeviceCodeResponse = {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval?: number;
  message?: string;
};

type TokenResponseOk = {
  token_type: 'Bearer' | string;
  scope: string;
  expires_in: number;
  ext_expires_in?: number;
  access_token: string;
  refresh_token?: string;
};

type TokenResponseErr = {
  error: string;
  error_description?: string;
  error_codes?: number[];
  timestamp?: string;
  trace_id?: string;
  correlation_id?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isTokenOk(value: unknown): value is TokenResponseOk {
  if (!isRecord(value)) return false;
  return typeof value.access_token === 'string' && typeof value.expires_in === 'number' && typeof value.scope === 'string';
}

function isTokenErr(value: unknown): value is TokenResponseErr {
  if (!isRecord(value)) return false;
  return typeof value.error === 'string';
}

function parseEnv(name: string): string {
  const v = process.env[name];
  if (typeof v !== 'string' || v.trim().length === 0) throw new Error(`Missing env ${name}`);
  return v.trim();
}

function getDataDir(): string {
  const raw = process.env.DATA_DIR;
  if (typeof raw === 'string' && raw.trim().length > 0) {
    const p = raw.trim();
    return path.isAbsolute(p) ? p : path.join(process.cwd(), p);
  }
  return path.join(process.cwd(), 'data');
}

function toBase64Url(input: string): string {
  return Buffer.from(input, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function shareUrlToShareId(url: string): string {
  return `u!${toBase64Url(url)}`;
}

async function readTokenCache(cachePath: string): Promise<TokenCache | null> {
  try {
    const raw = await fs.readFile(cachePath, 'utf8');
    const parsedUnknown: unknown = JSON.parse(raw);
    if (!isRecord(parsedUnknown)) return null;
    const accessToken = parsedUnknown.accessToken;
    const expiresAtMs = parsedUnknown.expiresAtMs;
    const scope = parsedUnknown.scope;
    const tenantId = parsedUnknown.tenantId;
    const clientId = parsedUnknown.clientId;
    if (
      typeof accessToken !== 'string' ||
      typeof expiresAtMs !== 'number' ||
      typeof scope !== 'string' ||
      typeof tenantId !== 'string' ||
      typeof clientId !== 'string'
    ) {
      return null;
    }
    const refreshToken = typeof parsedUnknown.refreshToken === 'string' ? parsedUnknown.refreshToken : undefined;
    return { accessToken, refreshToken, expiresAtMs, scope, tenantId, clientId };
  } catch {
    return null;
  }
}

async function writeTokenCache(cachePath: string, value: TokenCache): Promise<void> {
  const dir = path.dirname(cachePath);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(cachePath, JSON.stringify(value, null, 2), 'utf8');
}

async function requestDeviceCode(args: { tenantId: string; clientId: string; scope: string }): Promise<DeviceCodeResponse> {
  const url = `https://login.microsoftonline.com/${encodeURIComponent(args.tenantId)}/oauth2/v2.0/devicecode`;
  const form = new URLSearchParams({ client_id: args.clientId, scope: args.scope });
  const res = await axios.post(url, form, { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  const dataUnknown: unknown = res.data;
  if (!isRecord(dataUnknown)) throw new Error('Unexpected device code response');
  const device_code = dataUnknown.device_code;
  const user_code = dataUnknown.user_code;
  const verification_uri = dataUnknown.verification_uri;
  const expires_in = dataUnknown.expires_in;
  const interval = dataUnknown.interval;
  const message = dataUnknown.message;
  if (
    typeof device_code !== 'string' ||
    typeof user_code !== 'string' ||
    typeof verification_uri !== 'string' ||
    typeof expires_in !== 'number'
  ) {
    throw new Error('Invalid device code response');
  }
  return {
    device_code,
    user_code,
    verification_uri,
    expires_in,
    interval: typeof interval === 'number' ? interval : undefined,
    message: typeof message === 'string' ? message : undefined,
  };
}

async function pollTokenByDeviceCode(args: {
  tenantId: string;
  clientId: string;
  deviceCode: string;
  intervalSeconds: number;
  timeoutMs: number;
}): Promise<TokenResponseOk> {
  const url = `https://login.microsoftonline.com/${encodeURIComponent(args.tenantId)}/oauth2/v2.0/token`;
  const startedAt = Date.now();
  while (Date.now() - startedAt < args.timeoutMs) {
    const form = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      client_id: args.clientId,
      device_code: args.deviceCode,
    });
    try {
      const res = await axios.post(url, form, { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
      const dataUnknown: unknown = res.data;
      if (isTokenOk(dataUnknown)) return dataUnknown;
      throw new Error('Unexpected token response');
    } catch (e) {
      if (!axios.isAxiosError(e)) throw e;
      const dataUnknown: unknown = e.response?.data;
      if (isTokenErr(dataUnknown)) {
        if (dataUnknown.error === 'authorization_pending') {
          await new Promise((r) => setTimeout(r, args.intervalSeconds * 1000));
          continue;
        }
        if (dataUnknown.error === 'slow_down') {
          await new Promise((r) => setTimeout(r, (args.intervalSeconds + 5) * 1000));
          continue;
        }
        if (dataUnknown.error === 'authorization_declined' || dataUnknown.error === 'access_denied') {
          const desc = typeof dataUnknown.error_description === 'string' ? dataUnknown.error_description : '';
          throw new Error(
            [
              `${dataUnknown.error}${desc ? `: ${desc}` : ''}`,
              'If you see "Need admin approval", an Entra admin must approve the app (Enterprise applications → Sharepoint_Reader → Permissions → Grant admin consent).',
            ].join('\n')
          );
        }
        const desc = typeof dataUnknown.error_description === 'string' ? dataUnknown.error_description : '';
        throw new Error(`${dataUnknown.error}${desc ? `: ${desc}` : ''}`);
      }
      const status = e.response?.status;
      throw new Error(`Token polling failed (status=${typeof status === 'number' ? status : 'unknown'})`);
    }
  }
  throw new Error('Device code timed out');
}

async function refreshAccessToken(args: { tenantId: string; clientId: string; refreshToken: string; scope: string }): Promise<TokenResponseOk> {
  const url = `https://login.microsoftonline.com/${encodeURIComponent(args.tenantId)}/oauth2/v2.0/token`;
  const form = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: args.clientId,
    refresh_token: args.refreshToken,
    scope: args.scope,
  });
  const res = await axios.post(url, form, { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  const dataUnknown: unknown = res.data;
  if (isTokenOk(dataUnknown)) return dataUnknown;
  throw new Error('Unexpected refresh token response');
}

async function acquireGraphToken(args: { tenantId: string; clientId: string; scope: string; cachePath: string }): Promise<string> {
  const cached = await readTokenCache(args.cachePath);
  const now = Date.now();
  if (cached && cached.clientId === args.clientId && cached.tenantId === args.tenantId && cached.scope === args.scope) {
    if (cached.expiresAtMs - now > 60_000) return cached.accessToken;
    if (cached.refreshToken) {
      const refreshed = await refreshAccessToken({
        tenantId: args.tenantId,
        clientId: args.clientId,
        refreshToken: cached.refreshToken,
        scope: args.scope,
      });
      const expiresAtMs = now + refreshed.expires_in * 1000;
      const next: TokenCache = {
        accessToken: refreshed.access_token,
        refreshToken: refreshed.refresh_token ?? cached.refreshToken,
        expiresAtMs,
        scope: refreshed.scope,
        tenantId: args.tenantId,
        clientId: args.clientId,
      };
      await writeTokenCache(args.cachePath, next);
      return next.accessToken;
    }
  }

  const device = await requestDeviceCode({ tenantId: args.tenantId, clientId: args.clientId, scope: args.scope });
  if (device.message) {
    console.log(device.message);
  } else {
    console.log(`Go to ${device.verification_uri} and enter code ${device.user_code}`);
  }

  const token = await pollTokenByDeviceCode({
    tenantId: args.tenantId,
    clientId: args.clientId,
    deviceCode: device.device_code,
    intervalSeconds: Math.max(1, device.interval ?? 5),
    timeoutMs: Math.max(60_000, device.expires_in * 1000),
  });

  const expiresAtMs = Date.now() + token.expires_in * 1000;
  const next: TokenCache = {
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    expiresAtMs,
    scope: token.scope,
    tenantId: args.tenantId,
    clientId: args.clientId,
  };
  await writeTokenCache(args.cachePath, next);
  return next.accessToken;
}

async function downloadDriveItemFromShareUrl(args: { shareUrl: string; token: string }): Promise<{ buf: Buffer; name?: string; webUrl?: string }> {
  const shareId = shareUrlToShareId(args.shareUrl);
  const itemUrl = `https://graph.microsoft.com/v1.0/shares/${encodeURIComponent(shareId)}/driveItem?$select=name,webUrl`;
  const itemRes = await axios.get(itemUrl, { headers: { Authorization: `Bearer ${args.token}` } });
  const itemUnknown: unknown = itemRes.data;
  const name = isRecord(itemUnknown) && typeof itemUnknown.name === 'string' ? itemUnknown.name : undefined;
  const webUrl = isRecord(itemUnknown) && typeof itemUnknown.webUrl === 'string' ? itemUnknown.webUrl : undefined;

  const contentUrl = `https://graph.microsoft.com/v1.0/shares/${encodeURIComponent(shareId)}/driveItem/content`;
  const contentRes = await axios.get<ArrayBuffer>(contentUrl, {
    headers: { Authorization: `Bearer ${args.token}` },
    responseType: 'arraybuffer',
    maxRedirects: 5,
  });
  return { buf: Buffer.from(contentRes.data), name, webUrl };
}

async function main(): Promise<void> {
  const shareUrl = process.argv[2];
  if (typeof shareUrl !== 'string' || shareUrl.trim().length === 0) {
    throw new Error('Usage: tsx src/sharepointDownloadLeaveSchedule.ts "<share_url>"');
  }

  const tenantId = parseEnv('MS_TENANT_ID');
  const clientId = parseEnv('MS_CLIENT_ID');
  const scope =
    (typeof process.env.MS_GRAPH_SCOPES === 'string' && process.env.MS_GRAPH_SCOPES.trim().length > 0
      ? process.env.MS_GRAPH_SCOPES.trim()
      : 'Files.Read');

  const dataDir = getDataDir();
  const cachePath = path.join(dataDir, 'sharepoint_token_cache.json');

  const token = await acquireGraphToken({ tenantId, clientId, scope, cachePath });
  const { buf, name, webUrl } = await downloadDriveItemFromShareUrl({ shareUrl: shareUrl.trim(), token });

  await fs.mkdir(dataDir, { recursive: true });
  const outName = typeof name === 'string' && name.trim().length > 0 ? name.trim() : 'leave_schedule.xlsx';
  const outPath = path.join(dataDir, outName);
  await fs.writeFile(outPath, buf);

  console.log('DOWNLOAD_OK');
  console.log(`Path: ${outPath}`);
  if (webUrl) console.log(`WebUrl: ${webUrl}`);
}

await main();
