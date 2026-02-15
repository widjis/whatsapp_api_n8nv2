import { pino } from 'pino';
import qrcode from 'qrcode';
import {
  Browsers,
  DisconnectReason,
  makeCacheableSignalKeyStore,
  makeWASocket,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';
import type { WASocket, proto } from '@whiskeysockets/baileys';
import type { Server as SocketIoServer } from 'socket.io';
import type { InMemoryStore } from './store.js';
import { extractMessageContent, resolveSenderNumber } from './utils.js';
import { handleN8nIntegration } from '../integrations/n8n.js';
import { resetPassword } from '../integrations/ldap.js';

let sock: WASocket | undefined;

export function getSocket(): WASocket | undefined {
  return sock;
}

export async function checkRegisteredNumber(jid: string): Promise<boolean> {
  if (!sock) {
    console.error('WhatsApp socket is not initialized.');
    return false;
  }
  try {
    const result = await sock.onWhatsApp(jid);
    const first = result?.[0];
    return Boolean(first?.exists);
  } catch (error) {
    console.error('Error checking registered number:', error);
    return false;
  }
}

type StartWhatsAppDeps = {
  io: SocketIoServer;
  store: InMemoryStore;
  authInfoDir: string;
  n8nWebhookUrl?: string;
  n8nTimeoutMs: number;
  allowedPhoneNumbers: string[];
};

function isNotifyUpsertPayload(
  value: unknown
): value is { type: 'notify'; messages: proto.IWebMessageInfo[] } {
  if (!value || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  if (obj.type !== 'notify') return false;
  const messages = obj.messages;
  return Array.isArray(messages);
}

async function handleMessage(args: {
  sock: WASocket;
  msg: proto.IWebMessageInfo;
  remoteJid: string;
  messageContent: string;
  deps: StartWhatsAppDeps;
}): Promise<void> {
  const { sock, msg, remoteJid, messageContent, deps } = args;
  const isGroup = remoteJid.endsWith('@g.us');
  const senderNumber = resolveSenderNumber({ msg, remoteJid, store: deps.store, authInfoDir: deps.authInfoDir });
  const pushName = msg.pushName ?? 'Unknown';
  if (isGroup) console.log(`Group Message from ${pushName} (${senderNumber}) in Group ${remoteJid}`);
  else console.log(`Private Message from ${pushName} (${senderNumber})`);
  console.log(`Content: ${messageContent}`);

  if (!deps.n8nWebhookUrl) return;

  await handleN8nIntegration({
    sock,
    remoteJid,
    payload: {
      message: messageContent,
      from: senderNumber,
      pushName,
      isGroup,
      groupId: isGroup ? remoteJid : null,
      timestamp: new Date().toISOString(),
      messageId: msg.key?.id,
    },
    config: { webhookUrl: deps.n8nWebhookUrl, timeoutMs: deps.n8nTimeoutMs },
  });
}

async function handleCommand(args: {
  sock: WASocket;
  msg: proto.IWebMessageInfo;
  remoteJid: string;
  messageContent: string;
  allowedPhoneNumbers: string[];
}): Promise<void> {
  const { sock, msg, remoteJid, messageContent, allowedPhoneNumbers } = args;
  if (!messageContent.startsWith('/')) return;
  const [command] = messageContent.trim().split(/\s+/);

  switch (command?.toLowerCase()) {
    case '/hi':
      await sock.sendMessage(remoteJid, { text: 'Hello!' });
      return;
    case '/help':
      await sock.sendMessage(remoteJid, { text: 'Available commands:\n/hi - Say hello\n/help - Show this help message' });
      return;
    case '/resetpassword': {
      const parts = messageContent.split(/ |\u00A0|'/);
      const username = parts[1];
      const newPassword = parts[2];

      if (!username || !newPassword) {
        await sock.sendMessage(remoteJid, {
          text: '❌ Usage: /resetpassword <username> <newPassword> [/change]\nExample: /resetpassword john.doe NewPass123 /change',
        });
        return;
      }

      const changePasswordAtNextLogon = parts.length > 3 && parts[3] === '/change';
      const match = remoteJid.match(/(\d+)@s\.whatsapp\.net/);
      const requester = match?.[1];
      if (!requester || (allowedPhoneNumbers.length > 0 && !allowedPhoneNumbers.includes(requester))) {
        await sock.sendMessage(remoteJid, { text: 'Access denied.' });
        return;
      }

      const result = await resetPassword({
        upn: username,
        newPassword,
        changePasswordAtNextLogon,
      });

      if (!result.success) {
        await sock.sendMessage(remoteJid, { text: `Error resetting password for ${username}: ${result.error}` });
        return;
      }

      await sock.sendMessage(remoteJid, { text: `Password reset for ${username} successful` });
      return;
    }
    default:
      return;
  }
}

export async function startWhatsApp(deps: StartWhatsAppDeps): Promise<void> {
  const { state, saveCreds } = await useMultiFileAuthState(deps.authInfoDir);

  sock = makeWASocket({
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'fatal' })),
    },
    printQRInTerminal: true,
    logger: pino({ level: 'fatal' }),
    browser: Browsers.macOS('Desktop'),
  });

  deps.store.bind(sock.ev);
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const connection = update.connection;
    const lastDisconnect = update.lastDisconnect;
    const qr = update.qr;

    if (qr) {
      console.log('QR Code received');
      const url = await qrcode.toDataURL(qr);
      deps.io.emit('qr', url);
      deps.io.emit('message', 'QR Code received, scan please!');
    }

    if (connection === 'close') {
      const statusCodeUnknown: unknown = (lastDisconnect?.error as unknown as { output?: { statusCode?: unknown } })
        .output?.statusCode;
      const statusCode = typeof statusCodeUnknown === 'number' ? statusCodeUnknown : undefined;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log('Connection closed due to ', lastDisconnect?.error, ', reconnecting ', shouldReconnect);
      deps.io.emit('message', 'Disconnected, reconnecting...');
      if (shouldReconnect) {
        await startWhatsApp(deps);
      }
      return;
    }

    if (connection === 'open') {
      console.log('Opened connection');
      deps.io.emit('ready', 'WhatsApp is ready!');
      deps.io.emit('message', 'WhatsApp is ready!');

      const currentSock = sock;
      if (!currentSock) return;

      try {
        const adminJid = '6285712612218@s.whatsapp.net';
        await currentSock.sendMessage(adminJid, { text: 'WhatsApp API Connected Successfully!' });
        console.log(`Sent connection message to ${adminJid}`);

        console.log('Fetching groups...');
        const groups = await currentSock.groupFetchAllParticipating();
        console.log('Groups list:');
        for (const group of Object.values(groups)) {
          console.log(`ID: ${group.id} | Name: ${group.subject}`);
        }
      } catch (error) {
        console.error('Error in post-connection tasks:', error);
      }
    }
  });

  sock.ev.on('messages.upsert', async (payloadUnknown) => {
    if (!isNotifyUpsertPayload(payloadUnknown)) return;

    const currentSock = sock;
    if (!currentSock) return;

    for (const msg of payloadUnknown.messages) {
      if (msg.key?.fromMe) continue;
      const remoteJid = msg.key?.remoteJid;
      if (!remoteJid) continue;
      const messageContent = extractMessageContent(msg);
      if (messageContent.startsWith('/')) {
        await handleCommand({
          sock: currentSock,
          msg,
          remoteJid,
          messageContent,
          allowedPhoneNumbers: deps.allowedPhoneNumbers,
        });
      } else {
        await handleMessage({ sock: currentSock, msg, remoteJid, messageContent, deps });
      }
    }
  });
}
