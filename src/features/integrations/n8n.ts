import https from 'node:https';
import { URL } from 'node:url';
import type { WASocket } from '@whiskeysockets/baileys';

type N8nPayload = {
  message: string;
  from: string;
  pushName: string;
  isGroup: boolean;
  groupId: string | null;
  timestamp: string;
  messageId: string | null | undefined;
};

type N8nConfig = {
  webhookUrl: string;
  timeoutMs: number;
};

function extractReplyText(data: unknown): string | undefined {
  if (typeof data === 'string') return data;

  if (Array.isArray(data) && data.length > 0) {
    const first = data[0];
    if (!first || typeof first !== 'object') return undefined;
    const obj = first as Record<string, unknown>;
    const value = obj.output ?? obj.message ?? obj.text ?? obj.response ?? obj.reply;
    return typeof value === 'string' ? value : undefined;
  }

  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    const value = obj.output ?? obj.message ?? obj.text ?? obj.response ?? obj.reply;
    return typeof value === 'string' ? value : undefined;
  }

  return undefined;
}

async function postHttpsJson(args: {
  url: string;
  payload: unknown;
  timeoutMs: number;
}): Promise<unknown> {
  const parsedUrl = new URL(args.url);
  const postData = JSON.stringify(args.payload);

  const options: https.RequestOptions = {
    hostname: parsedUrl.hostname,
    port: parsedUrl.port ? Number(parsedUrl.port) : 443,
    path: parsedUrl.pathname + parsedUrl.search,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(postData),
    },
    rejectUnauthorized: false,
    timeout: args.timeoutMs,
  };

  return new Promise<unknown>((resolve, reject) => {
    const req = https.request(options, (res) => {
      let responseData = '';
      res.on('data', (chunk) => {
        responseData += chunk;
      });
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          try {
            const parsed: unknown = JSON.parse(responseData);
            resolve(parsed);
          } catch {
            resolve({});
          }
          return;
        }

        reject(new Error(`HTTP ${res.statusCode ?? 0}: ${res.statusMessage ?? ''}`));
      });
    });

    req.on('error', (error) => {
      reject(error);
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });

    req.write(postData);
    req.end();
  });
}

async function postFetchJson(args: { url: string; payload: unknown }): Promise<unknown> {
  const response = await fetch(args.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(args.payload),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    return (await response.json()) as unknown;
  }
  return await response.text();
}

export async function handleN8nIntegration(args: {
  sock: WASocket;
  remoteJid: string;
  payload: N8nPayload;
  config: N8nConfig;
}): Promise<void> {
  const { sock, remoteJid, payload, config } = args;

  try {
    const data = config.webhookUrl.startsWith('https://')
      ? await postHttpsJson({ url: config.webhookUrl, payload, timeoutMs: config.timeoutMs })
      : await postFetchJson({ url: config.webhookUrl, payload });

    const replyText = extractReplyText(data);
    if (replyText) {
      await sock.sendMessage(remoteJid, { text: replyText });
    }
  } catch (error) {
    console.error('Error sending to N8N:', error);
  }
}

