import https from 'node:https';
import { URL } from 'node:url';
import type { WASocket } from '@whiskeysockets/baileys';

export type N8nAttachment = {
  type: 'image' | 'video' | 'audio' | 'document';
  caption: string;
  mimetype: string;
  fileLength: number;
  fileName: string | null;
  seconds: number | null;
  width: number | null;
  height: number | null;
  ptt: boolean | null;
  dataBase64: string | null;
  error: string | null;
};

type N8nPayload = {
  message: string;
  from: string;
  pushName: string;
  isGroup: boolean;
  groupId: string | null;
  timestamp: string;
  messageId: string | null | undefined;
  attachments?: N8nAttachment[];
};

type N8nConfig = {
  webhookUrl: string;
  timeoutMs: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function tryExtractFromValue(value: unknown, depth: number): string | undefined {
  if (typeof value === 'string') return value;
  if (depth <= 0) return undefined;

  if (Array.isArray(value)) {
    for (const item of value) {
      const v = tryExtractFromValue(item, depth - 1);
      if (v) return v;
    }
    return undefined;
  }

  if (isRecord(value)) {
    const direct = value.output ?? value.reply ?? value.message ?? value.text ?? value.response;
    const directText = tryExtractFromValue(direct, depth - 1);
    if (directText) return directText;

    const containers = [value.json, value.data, value.result, value.body];
    for (const container of containers) {
      const nested = tryExtractFromValue(container, depth - 1);
      if (nested) return nested;
    }

    return undefined;
  }

  return undefined;
}

function extractReplyText(data: unknown): string | undefined {
  return tryExtractFromValue(data, 5);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendReplyWithTyping(args: { sock: WASocket; remoteJid: string; text: string; isGroup: boolean }): Promise<void> {
  const typingEnabled = process.env.TYPING_ENABLED === 'true';
  if (!typingEnabled) {
    await args.sock.sendMessage(args.remoteJid, { text: args.text });
    return;
  }

  try {
    await args.sock.sendPresenceUpdate('composing', args.remoteJid);
    await sleep(1500);
  } catch {
    // ignore
  }

  await args.sock.sendMessage(args.remoteJid, { text: args.text });

  try {
    await args.sock.sendPresenceUpdate('available', args.remoteJid);
  } catch {
    // ignore
  }
}

async function sendDefaultReply(args: { sock: WASocket; remoteJid: string; isGroup: boolean }): Promise<void> {
  const text = args.isGroup
    ? 'Currently, AI system is not available, please wait.'
    : 'Currently, AI system is not available, please wait.\n\nPlease try again later.';
  await sendReplyWithTyping({ sock: args.sock, remoteJid: args.remoteJid, text, isGroup: args.isGroup });
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
      'User-Agent': 'WhatsApp-AI-Bot/1.0',
      ...(process.env.N8N_API_KEY ? { Authorization: `Bearer ${process.env.N8N_API_KEY}` } : {}),
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
            resolve(responseData);
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
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'WhatsApp-AI-Bot/1.0',
      ...(process.env.N8N_API_KEY ? { Authorization: `Bearer ${process.env.N8N_API_KEY}` } : {}),
    },
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

  const n8nEnabled = process.env.N8N_ENABLED ? process.env.N8N_ENABLED === 'true' : true;
  if (!n8nEnabled) return;

  try {
    const data = config.webhookUrl.startsWith('https://')
      ? await postHttpsJson({ url: config.webhookUrl, payload, timeoutMs: config.timeoutMs })
      : await postFetchJson({ url: config.webhookUrl, payload });

    const replyText = extractReplyText(data);
    if (replyText) {
      await sendReplyWithTyping({ sock, remoteJid, text: replyText, isGroup: payload.isGroup });
      return;
    }

    await sendDefaultReply({ sock, remoteJid, isGroup: payload.isGroup });
  } catch (error) {
    console.error('Error sending to N8N:', error);
    await sendDefaultReply({ sock, remoteJid, isGroup: payload.isGroup });
  }
}
