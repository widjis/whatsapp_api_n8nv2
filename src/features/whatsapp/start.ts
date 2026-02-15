import { pino } from 'pino';
import qrcode from 'qrcode';
import path from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  makeCacheableSignalKeyStore,
  makeWASocket,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';
import type { WASocket, proto, WAMessage } from '@whiskeysockets/baileys';
import type { Server as SocketIoServer } from 'socket.io';
import type { InMemoryStore } from './store.js';
import { resolveSenderNumber } from './utils.js';
import { handleN8nIntegration, type N8nAttachment, type N8nQuotedMessage } from '../integrations/n8n.js';
import {
  findAdUserByPhone,
  findUsersByCommonName,
  getBitLockerInfo,
  renderFindUserCaption,
  resetPassword,
  type AdUserInfo,
} from '../integrations/ldap.js';
import { buildGetAssetReply, CATEGORY_MAPPING } from '../integrations/snipeIt.js';
import {
  addTechnicianContact,
  deleteTechnicianContact,
  getContactByPhone,
  getTechnicianContactsPath,
  getTechnicianContactById,
  listTechnicianContacts,
  normalizeTechnicianPhoneNumber,
  searchTechnicianContacts,
  updateTechnicianContact,
} from '../integrations/technicianContacts.js';
import type { TechnicianContact, TechnicianContactUpdateField } from '../integrations/technicianContacts.js';
import { claimTicketNotification, loadTicketNotification, unclaimTicketNotification } from '../tickets/claimStore.js';
import { updateRequest, viewRequest } from '../integrations/ticketHandle.js';

let sock: WASocket | undefined;
const mediaLogger = pino({ level: 'fatal' });

const MESSAGE_BUFFER_ENABLED = process.env.MESSAGE_BUFFER_ENABLED === 'true';
const MESSAGE_BUFFER_TIMEOUT_MS = Number(process.env.MESSAGE_BUFFER_TIMEOUT ?? '3000');
const PRESENCE_BUFFER_ENABLED = process.env.PRESENCE_BUFFER_ENABLED === 'true';
const PRESENCE_BUFFER_MAX_TIMEOUT_MS = Number(process.env.PRESENCE_BUFFER_MAX_TIMEOUT ?? '10000');
const PRESENCE_BUFFER_STOP_DELAY_MS = Number(process.env.PRESENCE_BUFFER_STOP_DELAY ?? '2000');
const PRESENCE_SUBSCRIPTION_ENABLED = process.env.PRESENCE_SUBSCRIPTION_ENABLED === 'true';
const DEBUG_TICKET_REACTIONS = process.env.DEBUG_TICKET_REACTIONS === 'true';

type MediaSendMode = 'base64' | 'file_url' | 'auto';

function readMediaSendMode(): MediaSendMode {
  const raw = process.env.N8N_MEDIA_SEND_MODE;
  if (!raw) return 'auto';
  const v = raw.trim().toLowerCase();
  if (v === 'base64' || v === 'file_url' || v === 'auto') return v;
  return 'auto';
}

function readPositiveIntEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i <= 0) return fallback;
  return i;
}

function resolveUploadsDir(): string {
  const rootDir = process.cwd();
  const dataRaw = process.env.DATA_DIR;
  const dataDir = dataRaw
    ? path.isAbsolute(dataRaw) ? dataRaw : path.join(rootDir, dataRaw)
    : rootDir;
  return path.join(dataDir, 'uploads');
}

function resolvePublicBaseUrl(): string | null {
  const raw = process.env.PUBLIC_BASE_URL;
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed;
}

function guessFileExtensionFromMime(mime: string, fallback: string): string {
  const m = mime.toLowerCase();
  if (m.includes('video/mp4')) return 'mp4';
  if (m.includes('video/quicktime')) return 'mov';
  if (m.includes('image/png')) return 'png';
  if (m.includes('image/webp')) return 'webp';
  if (m.includes('image/jpeg')) return 'jpg';
  if (m.includes('audio/ogg')) return 'ogg';
  if (m.includes('audio/mpeg')) return 'mp3';
  if (m.includes('application/pdf')) return 'pdf';
  return fallback;
}

function buildUploadsFileUrl(baseUrl: string, fileName: string): string {
  return `${baseUrl}/uploads/${encodeURIComponent(fileName)}`;
}

type TicketReactionDebugPayload = {
  event: 'claim' | 'unclaim';
  remoteJid: string;
  messageId: string;
  participantRaw?: string;
  participantResolved?: string;
  participantDigits?: string | null;
  sockUserJid?: string;
  sockDigits?: string | null;
};

function logTicketReactionDebug(payload: TicketReactionDebugPayload): void {
  if (!DEBUG_TICKET_REACTIONS) return;
  console.log('[ticket-reaction]', JSON.stringify(payload));
}

type PresenceState = { isTyping: boolean; lastUpdateMs: number };
type BufferedMessage = {
  msg: proto.IWebMessageInfo;
  text: string;
  attachments: N8nAttachment[];
  remoteJid: string;
  senderNumber: string;
  pushName: string;
  isGroup: boolean;
  shouldReply: boolean;
  messageType: ParsedIncomingMessage['messageType'];
  mentionedJids: string[];
  quotedMessage: N8nQuotedMessage | null;
};

type MessageBuffer = {
  items: BufferedMessage[];
  timer: ReturnType<typeof setTimeout> | null;
  typingTimer: ReturnType<typeof setTimeout> | null;
  lastMessageTimeMs: number;
  isTyping: boolean;
};

const messageBuffers = new Map<string, MessageBuffer>();
const presenceStatus = new Map<string, PresenceState>();

const adUserCache = new Map<string, { value: AdUserInfo | null; expiresAtMs: number }>();

function getAdUserCacheTtlMs(): number {
  const raw = process.env.ADUSER_CACHE_TTL_MS;
  const value = raw ? Number(raw) : 600_000;
  if (!Number.isFinite(value) || value <= 0) return 600_000;
  return value;
}

async function resolveAdUser(args: { senderDigits: string | null; senderJid: string; pushName: string | null }): Promise<AdUserInfo | null> {
  const key = args.senderDigits ?? args.senderJid;
  const cached = adUserCache.get(key);
  const now = Date.now();
  if (cached && cached.expiresAtMs > now) return cached.value;

  const value = await findAdUserByPhone({ phone: key, pushName: args.pushName });
  adUserCache.set(key, { value, expiresAtMs: now + getAdUserCacheTtlMs() });
  return value;
}

function getBufferKey(args: { remoteJid: string; senderNumber: string }): string {
  return `${args.remoteJid}|${args.senderNumber}`;
}

function subscribeToPresence(args: { sock: WASocket; jid: string }): void {
  if (!PRESENCE_SUBSCRIPTION_ENABLED) return;
  try {
    args.sock.presenceSubscribe(args.jid);
  } catch {
  }
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function extractPresenceItems(payloadUnknown: unknown): Array<{ remoteJid: string; participantJid: string; presence: string }> {
  if (!isRecordValue(payloadUnknown)) return [];
  const id = payloadUnknown.id;
  const presencesUnknown = payloadUnknown.presences;
  if (typeof id !== 'string' || !isRecordValue(presencesUnknown)) return [];

  const out: Array<{ remoteJid: string; participantJid: string; presence: string }> = [];
  for (const [participantJid, value] of Object.entries(presencesUnknown)) {
    if (!isRecordValue(value)) continue;
    const lastKnownPresence = value.lastKnownPresence;
    if (typeof lastKnownPresence !== 'string') continue;
    out.push({ remoteJid: id, participantJid, presence: lastKnownPresence });
  }
  return out;
}

function isPresenceTyping(presence: string): boolean {
  return presence === 'composing' || presence === 'recording';
}

function scheduleFlush(args: {
  key: string;
  buffer: MessageBuffer;
  forceMaxTimeout: boolean;
}): void {
  const buffer = args.buffer;
  if (buffer.timer) clearTimeout(buffer.timer);
  if (buffer.typingTimer) clearTimeout(buffer.typingTimer);
  buffer.typingTimer = null;

  if (PRESENCE_BUFFER_ENABLED) {
    buffer.timer = setTimeout(
      () => {
        void flushMessageBuffer(args.key);
      },
      args.forceMaxTimeout ? PRESENCE_BUFFER_MAX_TIMEOUT_MS : PRESENCE_BUFFER_STOP_DELAY_MS
    );
    return;
  }

  buffer.timer = setTimeout(() => {
    void flushMessageBuffer(args.key);
  }, MESSAGE_BUFFER_TIMEOUT_MS);
}

function addToMessageBuffer(item: BufferedMessage): boolean {
  if (!MESSAGE_BUFFER_ENABLED) return false;

  const key = getBufferKey({ remoteJid: item.remoteJid, senderNumber: item.senderNumber });
  const now = Date.now();

  if (!messageBuffers.has(key)) {
    messageBuffers.set(key, {
      items: [],
      timer: null,
      typingTimer: null,
      lastMessageTimeMs: now,
      isTyping: false,
    });

    const currentSock = sock;
    if (currentSock) {
      subscribeToPresence({ sock: currentSock, jid: item.senderNumber });
    }
  }

  const buffer = messageBuffers.get(key);
  if (!buffer) return false;

  buffer.items.push(item);
  buffer.lastMessageTimeMs = now;

  const presence = presenceStatus.get(key);
  const currentlyTyping = Boolean(presence?.isTyping);
  scheduleFlush({ key, buffer, forceMaxTimeout: currentlyTyping });
  return true;
}

async function flushMessageBuffer(key: string): Promise<void> {
  const buffer = messageBuffers.get(key);
  if (!buffer || buffer.items.length === 0) return;

  if (buffer.timer) clearTimeout(buffer.timer);
  if (buffer.typingTimer) clearTimeout(buffer.typingTimer);
  messageBuffers.delete(key);

  const combinedText = buffer.items.map((i) => i.text).filter((t) => t.trim().length > 0).join('\n');
  if (combinedText.trim().startsWith('/')) return;

  const first = buffer.items[0];
  if (!first) return;

  const combinedAttachments: N8nAttachment[] = [];
  for (const item of buffer.items) {
    for (const att of item.attachments) combinedAttachments.push(att);
  }

  const mentionedSet = new Set<string>();
  for (const item of buffer.items) {
    for (const jid of item.mentionedJids) mentionedSet.add(jid);
  }
  const combinedMentionedJids = Array.from(mentionedSet);

  const currentSock = sock;
  const deps = activeDeps;
  if (!currentSock || !deps) return;

  await handleMessage({
    sock: currentSock,
    msg: first.msg,
    remoteJid: first.remoteJid,
    messageContent: combinedText || first.text,
    attachments: combinedAttachments,
    messageType: first.messageType,
    mentionedJids: combinedMentionedJids,
    quotedMessage: first.quotedMessage,
    shouldReply: first.shouldReply,
    deps,
  });
}

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

type CommandHelpEntry = {
  usage: string;
  description: string;
  details?: string;
  available?: string;
  examples?: string[];
};

const HELP_COMMANDS_TEXT =
  `*Available Commands:*\n`
  + `*User Commands:*\n`
  + `- /finduser\n`
  + `- /resetpassword\n`
  + `- /newuser\n`
  + `\n*WiFi Commands:*\n`
  + `- /addwifi\n`
  + `- /checkwifi\n`
  + `- /movewifi\n`
  + `- /pools\n`
  + `- /leasereport\n`
  + `\n*System Commands:*\n`
  + `- /getups\n`
  + `- /getasset\n`
  + `- /getbitlocker\n`
  + `\n*License Commands:*\n`
  + `- /licenses\n`
  + `- /getlicense\n`
  + `- /expiring\n`
  + `- /licensereport\n`
  + `\n*Helpdesk Commands:*\n`
  + `- /ticketreport\n`
  + `\n*Alert Commands:*\n`
  + `- /ack\n`
  + `\n*To get detailed help for a specific command, use:*\n`
  + `- /help <command>\n\n`
  + `*Example:*\n`
  + `- /help finduser`;

const COMMAND_HELP: Record<string, CommandHelpEntry> = {
  finduser: {
    usage: '/finduser <name> [/photo]',
    description: 'Finds users in Active Directory by display name (CN).',
    details:
      'Searches by partial match on common name (CN). Returns display name, email, title, department, phone, and password info. Add `/photo` to include the user photo if available in AD.',
    examples: ['/finduser peggy', '/finduser "john doe"', '/finduser peggy /photo'],
  },
  resetpassword: {
    usage: '/resetpassword <username> <new_password> [/change]',
    description:
      'Resets the password for the given username. Optionally, use the `/change` flag to require the user to change their password at the next logon.',
    examples: ['/resetpassword johndoe newpassword123', '/resetpassword johndoe newpassword123 /change'],
  },
  getups: {
    usage: '/getups <ups_id>',
    description: 'Gets the details of the UPS with the given ID.',
    available: 'Available UPS Identifiers: pyr (Pyrite), mkt (Makarti)',
    examples: ['/getups pyr', '/getups mkt'],
  },
  getasset: {
    usage: '/getasset [type]',
    description: 'Summarizes assets from Snipe-IT by category.',
    available: `Types: ${Object.keys(CATEGORY_MAPPING).sort().join(', ')}`,
    examples: ['/getasset', '/getasset pc', '/getasset notebook', '/getasset monitor'],
  },
  addwifi: {
    usage: '/addwifi <pool> <mac> <comment> [/days <number_of_days>]',
    description:
      'Adds a WiFi user with the given MAC address and comment. Optionally, specify the number of days until expiration.',
    examples: [
      '/addwifi /staff 00:1A:2B:3C:4D:5E John Doe - Staff Member',
      '/addwifi /staff 00:1A:2B:3C:4D:5E /days 7 John Doe - Temporary Staff',
    ],
  },
  checkwifi: {
    usage: '/checkwifi <mac>',
    description: 'Checks the status of the WiFi user with the given MAC address.',
  },
  movewifi: {
    usage: '/movewifi <old_pool> <new_pool> <mac>',
    description: 'Moves the WiFi user with the given MAC address from the old pool to the new pool.',
  },
  newuser: {
    usage: '/newuser <username> <email>',
    description: 'Creates a new user with the given username and email.',
  },
  pools: {
    usage: '/pools',
    description:
      'Lists all available pools.\n- * /staff*, * /nonstaff*, and * /management*: mobile phones (WiFi MTI-02).\n- * /employeefull* and * /employeelimited*: laptops (WiFi MTI-01).\n- * /contractor*: laptops (WiFi MTI-03).',
  },
  leasereport: {
    usage: '/leasereport',
    description: 'Displays all users with a limited expiration date.',
  },
  getbitlocker: {
    usage: '/getbitlocker <hostname>',
    description: 'Retrieves BitLocker recovery keys for the specified hostname from Active Directory.',
    examples: ['/getbitlocker mti-nb-123'],
  },
  ticketreport: {
    usage: '/ticketreport [days] [technicianName]',
    description:
      'Generates a report of tickets created in the last specified number of days. Optionally, filter the report by technician name.',
    available: 'If no days are specified, defaults to the last 7 days.',
    examples: ['/ticketreport', '/ticketreport 14', '/ticketreport 30 peggy'],
  },
  technician: {
    usage: '/technician <command> [parameters]',
    description:
      "Comprehensive technician contact management system for IT support operations. Manage your team's contact information with full CRUD capabilities.",
    available:
      '📋 **Available Commands:**\n• **list** - Display all technicians\n• **search <query>** - Find technicians by name, phone, email, or role\n• **view <id>** - Show detailed info for specific technician\n• **add** - Add new technician with full details\n• **update** - Modify existing technician information\n• **delete** - Remove technician from database',
    examples: [
      '📋 **List all technicians:**\n/technician list',
      '🔍 **Search for specific technician:**\n/technician search Peggy\n/technician search "IT Support"\n/technician search 08123',
      '👤 **View technician details:**\n/technician view 5',
      '➕ **Add new technician:**\n/technician add "Ahmad Rizki" "Ahmad Rizki (Network Admin)" "08123456789" "ahmad.rizki@company.com" "Network Administrator" "Male"',
      '✏️ **Update technician info:**\n/technician update 3 "phone" "08987654321"\n/technician update 7 "email" "new.email@company.com"\n/technician update 2 "technician" "Senior IT Support"',
      '🗑️ **Remove technician:**\n/technician delete 8',
    ],
    details:
      '**Real-world Usage Scenarios:**\n\n🔧 **Daily Operations:**\n• Quickly find technician contact during emergencies\n• Update phone numbers when staff get new devices\n• Add new team members with complete contact info\n• Search by role to find specialists (e.g., "Network", "Security")\n\n📱 **Search Tips:**\n• Search by partial name: "Peg" finds "Peggy"\n• Search by role: "IT Support" finds all support staff\n• Search by phone: "0812" finds numbers starting with 0812\n• Search is case-insensitive and matches partial text\n\n⚠️ **Important Notes:**\n• Use quotes for multi-word values: "John Doe"\n• Available fields for update: name, ict_name, phone, email, technician, gender\n• Each technician has a unique ID for precise operations\n• Changes are saved immediately to the database',
  },
  licenses: {
    usage: '/licenses [limit] [offset]',
    description: 'Lists all software licenses with pagination support.',
    details:
      'Retrieves licenses from Snipe-IT asset management system. Default limit is 50 licenses per page. Use offset for pagination.',
    examples: ['/licenses', '/licenses 10', '/licenses 10 0'],
  },
  getlicense: {
    usage: '/getlicense <name_or_id>',
    description: 'Gets detailed information about a specific license by name or ID.',
    details:
      'Searches for licenses by exact name match or ID. Returns details including manufacturer, purchase information, seat allocation, and expiration dates.',
    examples: ['/getlicense Microsoft Office', '/getlicense 123', '/getlicense "Adobe Creative Suite"'],
  },
  expiring: {
    usage: '/expiring [days]',
    description: 'Lists licenses expiring within specified number of days (default: 30).',
    details:
      'Shows license name, usage, total seats, and days until expiration. Useful for proactive renewals.',
    examples: ['/expiring', '/expiring 30', '/expiring 90'],
  },
  licensereport: {
    usage: '/licensereport',
    description: 'Generates a comprehensive license utilization report with statistics.',
    details:
      'Provides overview of total licenses, utilization rates, expiration status, and category breakdown.',
    examples: ['/licensereport'],
  },
  ack: {
    usage: '/ack [alert_id] or reply to alert message with /ack',
    description:
      'Acknowledges a Veeam alert. Can be used by replying to an alert message or providing the alert ID directly.',
    examples: ['/ack db95c987-a404-45b0-ba2c-c406f483e5b9'],
  },
};

function renderCommandHelp(commandKey: string): string | undefined {
  const details = COMMAND_HELP[commandKey];
  if (!details) return undefined;

  let helpText = `*Usage:* ${details.usage}\n*Description:* ${details.description}`;
  if (details.details) helpText += `\n*Details:* ${details.details}`;
  if (details.available) helpText += `\n*Available:* ${details.available}`;
  if (details.examples && details.examples.length > 0) {
    helpText += `\n*Example(s):*\n${details.examples.join('\n')}`;
  }
  return helpText;
}

type StartWhatsAppDeps = {
  io: SocketIoServer;
  store: InMemoryStore;
  authInfoDir: string;
  n8nWebhookUrl?: string;
  n8nTimeoutMs: number;
  allowedPhoneNumbers: string[];
};

let activeDeps: StartWhatsAppDeps | null = null;

type ParsedIncomingMessage = {
  text: string;
  attachments: N8nAttachment[];
  messageType: 'text' | 'extended_text' | 'image' | 'video' | 'audio' | 'document' | 'unknown';
  mentionedJids: string[];
  quotedMessage: N8nQuotedMessage | null;
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

function splitCommandLine(input: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (!ch) continue;

    if (quote) {
      if (ch === quote) {
        quote = null;
        continue;
      }
      current += ch;
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }

    if (/\s/.test(ch)) {
      if (current) tokens.push(current);
      current = '';
      continue;
    }

    current += ch;
  }

  if (current) tokens.push(current);
  return tokens;
}

function getRequesterPhoneFromMessage(msg: proto.IWebMessageInfo, remoteJid: string): string | undefined {
  const senderJid = remoteJid.endsWith('@g.us') ? msg.key?.participant : remoteJid;
  if (!senderJid) return undefined;
  const match = senderJid.match(/(\d+)@s\.whatsapp\.net/);
  return match?.[1];
}

function parseReactionGroupIds(): Set<string> {
  const raw = process.env.TICKET_REACTION_GROUP_IDS;
  if (!raw) return new Set();
  const parts = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return new Set(parts);
}

function extractReactionTargetFromMessage(
  message: unknown
): { messageId: string; remoteJid?: string; text?: string | null } | null {
  if (!isRecordValue(message)) return null;

  const reactionMessage = message.reactionMessage;
  if (isRecordValue(reactionMessage)) {
    const key = reactionMessage.key;
    if (!isRecordValue(key)) return null;
    const messageId = typeof key.id === 'string' ? key.id : '';
    const remoteJid = typeof key.remoteJid === 'string' ? key.remoteJid : undefined;
    const text =
      typeof reactionMessage.text === 'string'
        ? reactionMessage.text
        : reactionMessage.text === null
          ? null
          : undefined;
    if (!messageId) return null;
    return { messageId, remoteJid, text };
  }

  const ephemeral = message.ephemeralMessage;
  if (isRecordValue(ephemeral)) {
    const inner = ephemeral.message;
    return extractReactionTargetFromMessage(inner);
  }

  return null;
}

function isReactionRemoved(reactionText: string | null | undefined): boolean {
  return reactionText === '' || reactionText === null;
}

async function handleTicketReactionClaim(args: {
  sock: WASocket;
  deps: StartWhatsAppDeps;
  remoteJid: string;
  messageId: string;
  participantRaw: string;
}): Promise<void> {
  const sockUserJid = args.sock.user?.id;
  const sockDigits = typeof sockUserJid === 'string' ? extractPhoneDigitsFromJid(sockUserJid) : null;
  if (typeof sockUserJid === 'string' && args.participantRaw === sockUserJid) return;

  const participantJid = resolveParticipantJid({
    participant: args.participantRaw,
    store: args.deps.store,
    authInfoDir: args.deps.authInfoDir,
  });
  if (typeof sockUserJid === 'string' && participantJid === sockUserJid) return;
  const digits = extractPhoneDigitsFromJid(participantJid);
  if (!digits) return;

  if (sockDigits && digits === sockDigits) return;

  logTicketReactionDebug({
    event: 'claim',
    remoteJid: args.remoteJid,
    messageId: args.messageId,
    participantRaw: args.participantRaw,
    participantResolved: participantJid,
    participantDigits: digits,
    sockUserJid: typeof sockUserJid === 'string' ? sockUserJid : undefined,
    sockDigits,
  });

  const reacterPhone = normalizeTechnicianPhoneNumber(digits);
  const tech = getContactByPhone(reacterPhone);
  const stored = await loadTicketNotification({ remoteJid: args.remoteJid, messageId: args.messageId });
  if (!stored) return;
  const ticketId = stored.ticketId;

  function renderClaimFailed(reason: string): string {
    return `*Ticket Claim Failed*\nTicket ID: ${ticketId}\nReason: ${reason}`;
  }

  function renderAlreadyClaimed(by: string): string {
    return `*Ticket Already Claimed*\nTicket ID: *${ticketId}*\nClaimed by: *${by}*`;
  }

  if (!tech) {
    await args.sock.sendMessage(args.remoteJid, {
      text: renderClaimFailed(`Phone ${reacterPhone} is not registered as a technician.`),
    });
    return;
  }

  if (stored.claimed) {
    const by = stored.claimedByName ?? stored.claimedByPhone ?? 'another technician';
    await args.sock.sendMessage(args.remoteJid, { text: renderAlreadyClaimed(by) });
    return;
  }

  const requestObj = await viewRequest(ticketId);
  const previousStatus = requestObj?.status?.name ?? null;
  const previousIctTechnician = requestObj?.udf_fields?.udf_pick_601 ?? null;
  const previousTechnicianName = requestObj?.technician?.name ?? null;
  const previousGroupNameUnknown: unknown = (requestObj as unknown as { group?: { name?: unknown } }).group?.name;
  const previousGroupName = typeof previousGroupNameUnknown === 'string' ? previousGroupNameUnknown : null;

  const claim = await claimTicketNotification({
    remoteJid: args.remoteJid,
    messageId: args.messageId,
    claimantPhone: reacterPhone,
    claimantName: tech.name,
    previous: {
      status: previousStatus,
      ictTechnician: previousIctTechnician,
      technicianName: previousTechnicianName,
      groupName: previousGroupName,
    },
  });

  if (!claim.ok) {
    const reason =
      claim.reason === 'not_found'
        ? 'Ticket notification was not found.'
        : claim.reason === 'invalid_record'
          ? 'Ticket notification record is invalid.'
          : claim.detail ?? 'Ticket notification storage error.';
    await args.sock.sendMessage(args.remoteJid, { text: renderClaimFailed(reason) });
    return;
  }

  if (claim.wasClaimed) {
    const by = claim.record.claimedByName ?? claim.record.claimedByPhone ?? 'another technician';
    await args.sock.sendMessage(args.remoteJid, { text: renderAlreadyClaimed(by) });
    return;
  }

  const priorityName = requestObj?.priority?.name;
  const priority = typeof priorityName === 'string' && priorityName.trim().length > 0 ? priorityName : 'Low';

  const groupName = determineServiceDeskGroupByRole(tech.technician);

  const updateRes = await updateRequest(ticketId, {
    ictTechnician: tech.ict_name,
    groupName,
    technicianName: tech.technician,
    status: 'In Progress',
    priority,
  });

  if (!updateRes.success) {
    await args.sock.sendMessage(args.remoteJid, {
      text:
        `*Ticket Claimed (Partial)*\n` +
        `Ticket ID: *${ticketId}*\n` +
        `Technician: *${tech.name}*\n` +
        `Update: Failed\n` +
        `Details: ${updateRes.message}`,
    });
    return;
  }

  await args.sock.sendMessage(args.remoteJid, {
    text: `✅ Ticket *${ticketId}* claimed.\nTechnician: *${tech.name}*\nStatus: *In Progress*`,
  });
}

async function handleTicketReactionUnclaim(args: {
  sock: WASocket;
  deps: StartWhatsAppDeps;
  remoteJid: string;
  messageId: string;
  participantRaw: string;
}): Promise<void> {
  const sockUserJid = args.sock.user?.id;
  const sockDigits = typeof sockUserJid === 'string' ? extractPhoneDigitsFromJid(sockUserJid) : null;
  if (typeof sockUserJid === 'string' && args.participantRaw === sockUserJid) return;

  const participantJid = resolveParticipantJid({
    participant: args.participantRaw,
    store: args.deps.store,
    authInfoDir: args.deps.authInfoDir,
  });
  if (typeof sockUserJid === 'string' && participantJid === sockUserJid) return;
  const digits = extractPhoneDigitsFromJid(participantJid);
  if (!digits) return;
  if (sockDigits && digits === sockDigits) return;

  logTicketReactionDebug({
    event: 'unclaim',
    remoteJid: args.remoteJid,
    messageId: args.messageId,
    participantRaw: args.participantRaw,
    participantResolved: participantJid,
    participantDigits: digits,
    sockUserJid: typeof sockUserJid === 'string' ? sockUserJid : undefined,
    sockDigits,
  });

  const reacterPhone = normalizeTechnicianPhoneNumber(digits);
  const stored = await loadTicketNotification({ remoteJid: args.remoteJid, messageId: args.messageId });
  if (!stored) return;
  if (!stored.claimed) return;
  if (stored.claimedByPhone && stored.claimedByPhone !== reacterPhone) return;

  const ticketId = stored.ticketId;

  const result = await unclaimTicketNotification({
    remoteJid: args.remoteJid,
    messageId: args.messageId,
    claimantPhone: reacterPhone,
  });

  if (!result.ok) return;
  if (!result.wasUnclaimed) return;

  const requestObj = await viewRequest(ticketId);
  const priorityName = requestObj?.priority?.name;
  const priority = typeof priorityName === 'string' && priorityName.trim().length > 0 ? priorityName : 'Low';

  const statusToRestore =
    typeof stored.previousStatus === 'string' && stored.previousStatus.trim().length > 0 ? stored.previousStatus : 'Open';

  const updateArgs: {
    status: string;
    priority: string;
    technicianName?: string | null;
    ictTechnician?: string;
    groupName?: string | null;
  } = { status: statusToRestore, priority };

  if (stored.previousTechnicianName !== undefined) {
    updateArgs.technicianName = stored.previousTechnicianName;
  } else {
    updateArgs.technicianName = null;
  }

  if (stored.previousGroupName !== undefined) {
    updateArgs.groupName = stored.previousGroupName;
  }

  if (typeof stored.previousIctTechnician === 'string' && stored.previousIctTechnician.trim().length > 0) {
    updateArgs.ictTechnician = stored.previousIctTechnician;
  }

  const updateRes = await updateRequest(ticketId, updateArgs);
  if (!updateRes.success) {
    await args.sock.sendMessage(args.remoteJid, {
      text:
        `*Ticket Unclaimed (Partial)*\n` +
        `Ticket ID: *${ticketId}*\n` +
        `Removed by: *${stored.claimedByName ?? stored.claimedByPhone ?? reacterPhone}*\n` +
        `Revert: Failed\n` +
        `Details: ${updateRes.message}`,
    });
    return;
  }

  const assignmentLabel =
    (typeof stored.previousTechnicianName === 'string' && stored.previousTechnicianName.trim().length > 0) ||
    (typeof stored.previousGroupName === 'string' && stored.previousGroupName.trim().length > 0)
      ? 'Restored'
      : 'Cleared';

  const by = stored.claimedByName ?? stored.claimedByPhone ?? reacterPhone;
  await args.sock.sendMessage(args.remoteJid, {
    text: `*Ticket Unclaimed*\nTicket ID: *${ticketId}*\nRemoved by: *${by}*\nStatus: *${statusToRestore}*\nAssignment: ${assignmentLabel}`,
  });
}

function resolveParticipantJid(args: { participant: string; store: InMemoryStore; authInfoDir: string }): string {
  const sender = args.participant;
  if (!sender.includes('@lid')) return sender;

  const contactId = args.store.contacts[sender]?.id;
  const mappedViaContacts = contactId ?? sender;
  if (!mappedViaContacts.includes('@lid')) return mappedViaContacts;

  const lidUser = sender.split('@')[0] ?? '';
  const mappingFile = path.join(args.authInfoDir, `lid-mapping-${lidUser}_reverse.json`);
  if (!existsSync(mappingFile)) return mappedViaContacts;

  try {
    const raw = readFileSync(mappingFile, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'string' && parsed) {
      return `${parsed}@s.whatsapp.net`;
    }
  } catch {
    return mappedViaContacts;
  }

  return mappedViaContacts;
}

function extractPhoneDigitsFromJid(jid: string): string | null {
  const match = jid.match(/(\d+)(?::\d+)?@(s\.whatsapp\.net|c\.us)/);
  return match?.[1] ?? null;
}

function unwrapEphemeralMessage(message: proto.IMessage | null | undefined): proto.IMessage | undefined {
  const inner = message?.ephemeralMessage?.message;
  return inner ?? (message ?? undefined);
}

function extractMentionedJids(message: proto.IMessage | undefined): string[] {
  const contexts = [
    message?.extendedTextMessage?.contextInfo,
    message?.imageMessage?.contextInfo,
    message?.videoMessage?.contextInfo,
    message?.audioMessage?.contextInfo,
    message?.documentMessage?.contextInfo,
  ];

  const out: string[] = [];
  for (const ctx of contexts) {
    const mentioned = ctx?.mentionedJid;
    if (!Array.isArray(mentioned)) continue;
    for (const item of mentioned) {
      if (typeof item === 'string' && item.length > 0) out.push(item);
    }
  }
  return Array.from(new Set(out));
}

function isTaggedInGroup(args: {
  sock: WASocket;
  deps: StartWhatsAppDeps;
  msg: proto.IWebMessageInfo;
  messageText: string;
}): boolean {
  const botJid = args.sock.user?.id;
  if (typeof botJid !== 'string' || botJid.length === 0) return false;

  const botDigits = extractPhoneDigitsFromJid(botJid);
  const botHandle = botJid.split('@')[0] ?? '';
  const botHandleBase = botHandle.split(':')[0] ?? botHandle;

  const text = args.messageText;
  const textMentioned =
    (botDigits ? text.includes(`@${botDigits}`) : false) ||
    (botHandleBase ? text.includes(`@${botHandleBase}`) : false) ||
    (botHandle ? text.includes(`@${botHandle}`) : false);

  const rawMessage = unwrapEphemeralMessage(args.msg.message);
  const mentionedJids = extractMentionedJids(rawMessage);
  const jidMentioned = mentionedJids.some((jid) => {
    const resolved = resolveParticipantJid({
      participant: jid,
      store: args.deps.store,
      authInfoDir: args.deps.authInfoDir,
    });
    if (resolved === botJid) return true;
    const digits = extractPhoneDigitsFromJid(resolved);
    if (botDigits && digits && botDigits === digits) return true;
    const base = (resolved.split('@')[0] ?? '').split(':')[0] ?? '';
    return base.length > 0 && base === botHandleBase;
  });

  return textMentioned || jidMentioned;
}

async function parseIncomingMessage(args: { sock: WASocket; msg: proto.IWebMessageInfo }): Promise<ParsedIncomingMessage> {
  if (!args.msg.key) return { text: '', attachments: [], messageType: 'unknown', mentionedJids: [], quotedMessage: null };
  const rawMessage = unwrapEphemeralMessage(args.msg.message);
  if (!rawMessage) return { text: '', attachments: [], messageType: 'unknown', mentionedJids: [], quotedMessage: null };

  const mentionedJids = extractMentionedJids(rawMessage);

  const contextInfo =
    rawMessage.extendedTextMessage?.contextInfo ??
    rawMessage.imageMessage?.contextInfo ??
    rawMessage.videoMessage?.contextInfo ??
    rawMessage.audioMessage?.contextInfo ??
    rawMessage.documentMessage?.contextInfo;

  async function parseQuotedMessage(): Promise<N8nQuotedMessage | null> {
    const quotedRaw = contextInfo?.quotedMessage;
    if (!quotedRaw) return null;

    const actualQuoted = unwrapEphemeralMessage(quotedRaw) ?? quotedRaw;

    async function downloadBufferFromMessage(message: proto.IMessage): Promise<Buffer | null> {
      try {
        const msgForDownload = { message } as unknown as WAMessage;
        const downloaded = await downloadMediaMessage(msgForDownload, 'buffer', {}, {
          logger: mediaLogger,
          reuploadRequest: args.sock.updateMediaMessage,
        });
        const buffer = Buffer.isBuffer(downloaded) ? downloaded : Buffer.from(downloaded as Uint8Array);
        return buffer;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error('Error downloading quoted media:', message);
        return null;
      }
    }

    let quotedText = '';
    let quotedType: N8nQuotedMessage['type'] = 'unknown';
    let quotedMediaInfo: N8nAttachment | null = null;

    if (actualQuoted.conversation) {
      quotedText = actualQuoted.conversation;
      quotedType = 'text';
    } else if (actualQuoted.extendedTextMessage?.text) {
      quotedText = actualQuoted.extendedTextMessage.text;
      quotedType = 'extended_text';
    } else if (actualQuoted.imageMessage) {
      quotedText = actualQuoted.imageMessage.caption || 'Image';
      quotedType = 'image';
      const buffer = await downloadBufferFromMessage({ imageMessage: actualQuoted.imageMessage });
      const dataBase64 = buffer ? buffer.toString('base64') : null;
      quotedMediaInfo = {
        type: 'image',
        caption: actualQuoted.imageMessage.caption ?? '',
        mimetype: actualQuoted.imageMessage.mimetype ?? 'image/jpeg',
        fileLength: Number(actualQuoted.imageMessage.fileLength ?? 0),
        fileName: null,
        seconds: null,
        width: Number(actualQuoted.imageMessage.width ?? 0) || null,
        height: Number(actualQuoted.imageMessage.height ?? 0) || null,
        ptt: null,
        dataBase64,
        imageData: dataBase64,
        error: dataBase64 ? null : 'Failed to download quoted image',
      };
    } else if (actualQuoted.videoMessage) {
      quotedText = actualQuoted.videoMessage.caption || 'Video';
      quotedType = 'video';
      const buffer = await downloadBufferFromMessage({ videoMessage: actualQuoted.videoMessage });
      const mediaSendMode = readMediaSendMode();
      const maxBytes = readPositiveIntEnv('N8N_MEDIA_MAX_BYTES', 1_000_000);
      const uploadsDir = resolveUploadsDir();
      const publicBaseUrl = resolvePublicBaseUrl();
      const preferUrl = mediaSendMode === 'file_url' || (mediaSendMode === 'auto' && buffer ? buffer.length > maxBytes : false);
      const shouldSendAsUrl = preferUrl && Boolean(publicBaseUrl);
      if (preferUrl && !publicBaseUrl) {
        console.warn(
          '[media] quoted_video:url_unavailable',
          JSON.stringify({ reason: 'PUBLIC_BASE_URL not set', mediaSendMode, maxBytes, bufferBytes: buffer?.length ?? 0 })
        );
      }
      const mime = actualQuoted.videoMessage.mimetype ?? 'video/mp4';
      const ext = guessFileExtensionFromMime(mime, 'mp4');
      const fileName = `${Date.now()}_${randomUUID()}.${ext}`;
      const filePath = shouldSendAsUrl && buffer ? path.join(uploadsDir, fileName) : null;
      if (filePath && buffer) {
        mkdirSync(uploadsDir, { recursive: true });
        writeFileSync(filePath, buffer);
      }
      const fileUrl = filePath && publicBaseUrl ? buildUploadsFileUrl(publicBaseUrl, fileName) : null;
      const dataBase64 = !shouldSendAsUrl && buffer ? buffer.toString('base64') : null;
      quotedMediaInfo = {
        type: 'video',
        caption: actualQuoted.videoMessage.caption ?? '',
        mimetype: mime,
        fileLength: Number(actualQuoted.videoMessage.fileLength ?? 0),
        fileName: null,
        seconds: Number(actualQuoted.videoMessage.seconds ?? 0) || 0,
        width: Number(actualQuoted.videoMessage.width ?? 0) || null,
        height: Number(actualQuoted.videoMessage.height ?? 0) || null,
        ptt: null,
        dataBase64,
        videoData: dataBase64,
        fileUrl,
        filePath,
        error: buffer ? null : 'Failed to download quoted video',
      };
    } else if (actualQuoted.audioMessage) {
      quotedText = actualQuoted.audioMessage.ptt ? 'Voice message' : 'Audio';
      quotedType = 'audio';
      const buffer = await downloadBufferFromMessage({ audioMessage: actualQuoted.audioMessage });
      const dataBase64 = buffer ? buffer.toString('base64') : null;
      quotedMediaInfo = {
        type: 'audio',
        caption: '',
        mimetype: actualQuoted.audioMessage.mimetype ?? 'audio/ogg',
        fileLength: Number(actualQuoted.audioMessage.fileLength ?? 0),
        fileName: null,
        seconds: Number(actualQuoted.audioMessage.seconds ?? 0) || 0,
        width: null,
        height: null,
        ptt: Boolean(actualQuoted.audioMessage.ptt),
        dataBase64,
        audioData: dataBase64,
        error: dataBase64 ? null : 'Failed to download quoted audio',
      };
    } else if (actualQuoted.documentMessage) {
      quotedText = actualQuoted.documentMessage.caption || actualQuoted.documentMessage.fileName || 'Document';
      quotedType = 'document';
      quotedMediaInfo = {
        type: 'document',
        caption: actualQuoted.documentMessage.caption ?? '',
        mimetype: actualQuoted.documentMessage.mimetype ?? 'application/octet-stream',
        fileLength: Number(actualQuoted.documentMessage.fileLength ?? 0),
        fileName: actualQuoted.documentMessage.fileName ?? null,
        seconds: null,
        width: null,
        height: null,
        ptt: null,
        dataBase64: null,
        error: null,
      };
    }

    const participant = typeof contextInfo?.participant === 'string' && contextInfo.participant.length > 0 ? contextInfo.participant : 'Unknown';
    const messageId = typeof contextInfo?.stanzaId === 'string' && contextInfo.stanzaId.length > 0 ? contextInfo.stanzaId : null;

    return {
      type: quotedType,
      text: quotedText,
      participant,
      messageId,
      mediaInfo: quotedMediaInfo,
      raw: quotedRaw,
    };
  }

  const quotedMessage = await parseQuotedMessage();

  if (rawMessage.conversation) return { text: rawMessage.conversation, attachments: [], messageType: 'text', mentionedJids, quotedMessage };
  if (rawMessage.extendedTextMessage?.text)
    return { text: rawMessage.extendedTextMessage.text, attachments: [], messageType: 'extended_text', mentionedJids, quotedMessage };
  if (rawMessage.buttonsResponseMessage?.selectedButtonId) {
    return { text: rawMessage.buttonsResponseMessage.selectedButtonId, attachments: [], messageType: 'unknown', mentionedJids, quotedMessage };
  }
  if (rawMessage.listResponseMessage?.singleSelectReply?.selectedRowId) {
    return {
      text: rawMessage.listResponseMessage.singleSelectReply.selectedRowId,
      attachments: [],
      messageType: 'unknown',
      mentionedJids,
      quotedMessage,
    };
  }
  if (rawMessage.templateButtonReplyMessage?.selectedId) {
    return { text: rawMessage.templateButtonReplyMessage.selectedId, attachments: [], messageType: 'unknown', mentionedJids, quotedMessage };
  }

  const msgForDownload: WAMessage = { ...args.msg, key: args.msg.key, message: rawMessage };

  async function downloadBuffer(): Promise<Buffer | null> {
    try {
      const downloaded = await downloadMediaMessage(msgForDownload, 'buffer', {}, {
        logger: mediaLogger,
        reuploadRequest: args.sock.updateMediaMessage,
      });
      const buffer = Buffer.isBuffer(downloaded) ? downloaded : Buffer.from(downloaded as Uint8Array);
      return buffer;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('Error downloading media:', message);
      return null;
    }
  }

  if (rawMessage.imageMessage) {
    const buffer = await downloadBuffer();
    const dataBase64 = buffer ? buffer.toString('base64') : null;
    const caption = rawMessage.imageMessage.caption ?? '';
    const attachment: N8nAttachment = {
      type: 'image',
      caption,
      mimetype: rawMessage.imageMessage.mimetype ?? 'image/jpeg',
      fileLength: Number(rawMessage.imageMessage.fileLength ?? 0),
      fileName: null,
      seconds: null,
      width: Number(rawMessage.imageMessage.width ?? 0) || null,
      height: Number(rawMessage.imageMessage.height ?? 0) || null,
      ptt: null,
      dataBase64,
      imageData: dataBase64,
      error: dataBase64 ? null : 'Failed to download image',
    };
    return { text: caption || 'Image message received', attachments: [attachment], messageType: 'image', mentionedJids, quotedMessage };
  }

  if (rawMessage.videoMessage) {
    const buffer = await downloadBuffer();
    const caption = rawMessage.videoMessage.caption ?? '';
    const mediaSendMode = readMediaSendMode();
    const maxBytes = readPositiveIntEnv('N8N_MEDIA_MAX_BYTES', 1_000_000);
    const uploadsDir = resolveUploadsDir();
    const publicBaseUrl = resolvePublicBaseUrl();
    const preferUrl = mediaSendMode === 'file_url' || (mediaSendMode === 'auto' && buffer ? buffer.length > maxBytes : false);
    const shouldSendAsUrl = preferUrl && Boolean(publicBaseUrl);
    if (preferUrl && !publicBaseUrl) {
      console.warn(
        '[media] video:url_unavailable',
        JSON.stringify({ reason: 'PUBLIC_BASE_URL not set', mediaSendMode, maxBytes, bufferBytes: buffer?.length ?? 0 })
      );
    }
    const mime = rawMessage.videoMessage.mimetype ?? 'video/mp4';
    const ext = guessFileExtensionFromMime(mime, 'mp4');
    const fileName = `${Date.now()}_${args.msg.key?.id ?? randomUUID()}.${ext}`;
    const filePath = shouldSendAsUrl && buffer ? path.join(uploadsDir, fileName) : null;
    if (filePath && buffer) {
      mkdirSync(uploadsDir, { recursive: true });
      writeFileSync(filePath, buffer);
    }
    const fileUrl = filePath && publicBaseUrl ? buildUploadsFileUrl(publicBaseUrl, fileName) : null;
    const dataBase64 = !shouldSendAsUrl && buffer ? buffer.toString('base64') : null;
    const attachment: N8nAttachment = {
      type: 'video',
      caption,
      mimetype: mime,
      fileLength: Number(rawMessage.videoMessage.fileLength ?? 0),
      fileName: null,
      seconds: Number(rawMessage.videoMessage.seconds ?? 0) || 0,
      width: Number(rawMessage.videoMessage.width ?? 0) || null,
      height: Number(rawMessage.videoMessage.height ?? 0) || null,
      ptt: null,
      dataBase64,
      videoData: dataBase64,
      fileUrl,
      filePath,
      error: buffer ? null : 'Failed to download video',
    };
    return { text: caption || 'Video message received', attachments: [attachment], messageType: 'video', mentionedJids, quotedMessage };
  }

  if (rawMessage.audioMessage) {
    const buffer = await downloadBuffer();
    const dataBase64 = buffer ? buffer.toString('base64') : null;
    const isPtt = Boolean(rawMessage.audioMessage.ptt);
    const attachment: N8nAttachment = {
      type: 'audio',
      caption: '',
      mimetype: rawMessage.audioMessage.mimetype ?? 'audio/ogg',
      fileLength: Number(rawMessage.audioMessage.fileLength ?? 0),
      fileName: null,
      seconds: Number(rawMessage.audioMessage.seconds ?? 0) || 0,
      width: null,
      height: null,
      ptt: isPtt,
      dataBase64,
      audioData: dataBase64,
      error: dataBase64 ? null : 'Failed to download audio',
    };
    return {
      text: isPtt ? 'Voice message received' : 'Audio message received',
      attachments: [attachment],
      messageType: 'audio',
      mentionedJids,
      quotedMessage,
    };
  }

  if (rawMessage.documentMessage) {
    const buffer = await downloadBuffer();
    const dataBase64 = buffer ? buffer.toString('base64') : null;
    const caption = rawMessage.documentMessage.caption ?? '';
    const attachment: N8nAttachment = {
      type: 'document',
      caption,
      mimetype: rawMessage.documentMessage.mimetype ?? 'application/octet-stream',
      fileLength: Number(rawMessage.documentMessage.fileLength ?? 0),
      fileName: rawMessage.documentMessage.fileName ?? null,
      seconds: null,
      width: null,
      height: null,
      ptt: null,
      dataBase64,
      documentData: dataBase64,
      error: dataBase64 ? null : 'Failed to download document',
    };
    const fallbackText = attachment.fileName ? `Document: ${attachment.fileName}` : 'Document message received';
    return { text: caption || fallbackText, attachments: [attachment], messageType: 'document', mentionedJids, quotedMessage };
  }

  return { text: 'Media/Other', attachments: [], messageType: 'unknown', mentionedJids, quotedMessage };
}

function pickReactionSenderFromUpsertMessage(args: {
  msg: proto.IWebMessageInfo;
  currentSock: WASocket;
  deps: StartWhatsAppDeps;
}): string | null {
  const msg = args.msg;
  const viaKey = typeof msg.key?.participant === 'string' && msg.key.participant ? msg.key.participant : undefined;
  const viaTopLevel =
    typeof (msg as unknown as { participant?: unknown }).participant === 'string'
      ? ((msg as unknown as { participant?: string }).participant ?? undefined)
      : undefined;

  const sockUserJid = args.currentSock.user?.id;
  const sockDigits = typeof sockUserJid === 'string' ? extractPhoneDigitsFromJid(sockUserJid) : null;

  const candidates = [viaTopLevel, viaKey].filter((v): v is string => typeof v === 'string' && v.length > 0);
  for (const candidate of candidates) {
    if (typeof sockUserJid === 'string' && candidate === sockUserJid) continue;
    const resolved = resolveParticipantJid({
      participant: candidate,
      store: args.deps.store,
      authInfoDir: args.deps.authInfoDir,
    });
    if (typeof sockUserJid === 'string' && resolved === sockUserJid) continue;
    const digits = extractPhoneDigitsFromJid(resolved);
    if (sockDigits && digits && digits === sockDigits) continue;
    return candidate;
  }

  if (
    sockDigits &&
    candidates.some((c) => {
      const resolved = resolveParticipantJid({ participant: c, store: args.deps.store, authInfoDir: args.deps.authInfoDir });
      return extractPhoneDigitsFromJid(resolved) === sockDigits;
    })
  ) {
    return null;
  }

  return candidates[0] ?? null;
}

function determineServiceDeskGroupByRole(role: string): string {
  const r = role.toLowerCase();
  if (r.includes('document control')) return 'ICT Document Controller';
  if (r.includes('it field support')) return 'ICT Network and Infrastructure';
  if (r.includes('it support')) return 'ICT System and Support';
  return 'ICT System and Support';
}

function truncateText(value: string, maxLen: number): string {
  if (value.length <= maxLen) return value;
  if (maxLen <= 3) return value.slice(0, maxLen);
  return `${value.slice(0, maxLen - 3)}...`;
}

function formatTwoColumnRows(rows: Array<{ label: string; value: string }>): string {
  const maxLabel = rows.reduce((m, r) => Math.max(m, r.label.length), 0);
  return rows.map((r) => `${r.label.padEnd(maxLabel)}  ${r.value}`).join('\n');
}

function renderTechnicianDetails(c: TechnicianContact): string {
  const email = c.email ?? 'N/A';
  const gender = c.gender ?? 'N/A';
  const rows = formatTwoColumnRows([
    { label: 'ID', value: String(c.id) },
    { label: 'Name', value: c.name },
    { label: 'ICT Name', value: c.ict_name },
    { label: 'Role', value: c.technician },
    { label: 'Phone', value: c.phone },
    { label: 'Email', value: email },
    { label: 'Gender', value: gender },
  ]);
  return `\`\`\`\n${rows}\n\`\`\``;
}

function renderTechnicianTable(contacts: TechnicianContact[]): string {
  const rows = contacts.map((c) => ({
    id: String(c.id),
    name: truncateText(c.name, 28),
    role: truncateText(c.technician, 28),
    phone: truncateText(c.phone, 18),
  }));

  const maxId = Math.max(2, ...rows.map((r) => r.id.length));
  const maxName = Math.max(4, ...rows.map((r) => r.name.length));
  const maxRole = Math.max(4, ...rows.map((r) => r.role.length));
  const maxPhone = Math.max(5, ...rows.map((r) => r.phone.length));

  const header = `${'ID'.padEnd(maxId)}  ${'Name'.padEnd(maxName)}  ${'Role'.padEnd(maxRole)}  ${'Phone'.padEnd(maxPhone)}`;
  const lines = rows.map(
    (r) => `${r.id.padEnd(maxId)}  ${r.name.padEnd(maxName)}  ${r.role.padEnd(maxRole)}  ${r.phone.padEnd(maxPhone)}`
  );

  return `\`\`\`\n${[header, ...lines].join('\n')}\n\`\`\``;
}

function isUpdateField(value: string): value is TechnicianContactUpdateField {
  return (
    value === 'name' ||
    value === 'ict_name' ||
    value === 'phone' ||
    value === 'email' ||
    value === 'technician' ||
    value === 'gender'
  );
}

async function handleMessage(args: {
  sock: WASocket;
  msg: proto.IWebMessageInfo;
  remoteJid: string;
  messageContent: string;
  attachments: N8nAttachment[];
  messageType?: string;
  mentionedJids?: string[];
  quotedMessage?: N8nQuotedMessage | null;
  shouldReply?: boolean;
  deps: StartWhatsAppDeps;
}): Promise<void> {
  const { sock, msg, remoteJid, messageContent, attachments, deps } = args;
  const isGroup = remoteJid.endsWith('@g.us');
  const senderNumber = resolveSenderNumber({ msg, remoteJid, store: deps.store, authInfoDir: deps.authInfoDir });
  const senderDigits = extractPhoneDigitsFromJid(senderNumber);
  const pushName = msg.pushName ?? 'Unknown';
  const shouldReply = args.shouldReply !== false;
  if (isGroup) console.log(`Group Message from ${pushName} (${senderNumber}) in Group ${remoteJid}`);
  else console.log(`Private Message from ${pushName} (${senderNumber})`);
  console.log(`Content: ${messageContent}`);

  if (!deps.n8nWebhookUrl) return;

  const botJid = sock.user?.id;
  const botNumber = typeof botJid === 'string' && botJid.length > 0 ? botJid : null;

  const adUser = await resolveAdUser({ senderDigits, senderJid: senderNumber, pushName });

  const directMediaInfo = attachments[0] ? { ...attachments[0], isQuoted: false, source: 'direct' as const } : null;
  const quotedMediaInfo = args.quotedMessage?.mediaInfo
    ? {
        ...args.quotedMessage.mediaInfo,
        isQuoted: true,
        source: 'quoted' as const,
        quotedFrom: args.quotedMessage.participant,
        quotedMessageId: args.quotedMessage.messageId,
      }
    : null;
  const media = directMediaInfo ?? quotedMediaInfo;
  const hasAttachment = Boolean(media);
  const attachmentType = media?.type ?? null;

  const baseTimeoutMs = deps.n8nTimeoutMs;
  const mediaSendMode = readMediaSendMode();
  const videoHasInlineData = media?.type === 'video' && Boolean(media.videoData ?? media.dataBase64);
  const effectiveTimeoutMs = videoHasInlineData && mediaSendMode !== 'file_url' ? Math.max(baseTimeoutMs, 60_000) : baseTimeoutMs;

  await handleN8nIntegration({
    sock,
    remoteJid,
    payload: {
      message: messageContent,
      from: senderNumber,
      fromNumber: senderDigits ?? senderNumber,
      replyTo: remoteJid,
      pushName,
      isGroup,
      groupId: isGroup ? remoteJid : null,
      timestamp: new Date().toISOString(),
      messageId: msg.key?.id,
      attachments: attachments.length > 0 ? attachments : undefined,
      attachmentCount: attachments.length,
      hasAttachment,
      attachmentType,
      mediaInfo: directMediaInfo,
      media,
      messageType: args.messageType ?? null,
      mentionedJids: args.mentionedJids ?? [],
      quotedMessage: args.quotedMessage ?? null,
      botNumber,
      botLid: null,
      shouldReply,
      adUser,
    },
    config: { webhookUrl: deps.n8nWebhookUrl, timeoutMs: effectiveTimeoutMs },
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
    case '/finduser': {
      const parts = messageContent.trim().split(/\s+/).slice(1);

      const photoIdx = parts.findIndex((p) => p.toLowerCase() === '/photo');
      const includePhoto = photoIdx !== -1;
      if (includePhoto) parts.splice(photoIdx, 1);

      if (parts.length === 0) {
        await sock.sendMessage(remoteJid, { text: 'Error: No name provided with /finduser command' });
        return;
      }

      const query = parts.join(' ');
      const result = await findUsersByCommonName({ query, includePhoto });
      if (!result.success) {
        await sock.sendMessage(remoteJid, { text: `Error finding user: ${result.error}` });
        return;
      }

      if (result.users.length === 0) {
        await sock.sendMessage(remoteJid, { text: 'User not found.' });
        return;
      }

      for (const user of result.users) {
        const rendered = renderFindUserCaption({ user, includePhoto });
        if (includePhoto && rendered.hasPhoto && rendered.photoBuffer) {
          await sock.sendMessage(remoteJid, { image: rendered.photoBuffer, caption: rendered.caption });
        } else {
          await sock.sendMessage(remoteJid, { text: rendered.caption });
        }
      }
      return;
    }
    case '/help':
      {
        const parts = messageContent.trim().split(/\s+/);
        const requested = parts[1]?.toLowerCase();
        if (requested) {
          const normalized = requested.startsWith('/') ? requested.slice(1) : requested;
          const helpText = renderCommandHelp(normalized);
          if (helpText) {
            await sock.sendMessage(remoteJid, { text: helpText });
            return;
          }

          await sock.sendMessage(remoteJid, {
            text: '*Unknown command.* Use /help to see the list of available commands.',
          });
          return;
        }

        await sock.sendMessage(remoteJid, { text: HELP_COMMANDS_TEXT });
        return;
      }
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
      const requester = getRequesterPhoneFromMessage(msg, remoteJid);
      if (!requester) {
        await sock.sendMessage(remoteJid, { text: 'Invalid phone number format.' });
        return;
      }

      if (allowedPhoneNumbers.length > 0 && !allowedPhoneNumbers.includes(requester)) {
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
    case '/getasset': {
      try {
        const reply = await buildGetAssetReply(messageContent);
        await sock.sendMessage(remoteJid, { text: reply });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await sock.sendMessage(remoteJid, { text: `Error getting assets: ${message}` });
      }
      return;
    }
    case '/getbitlocker': {
      const hostname = messageContent.trim().split(/\s+/)[1];

      if (!hostname) {
        await sock.sendMessage(remoteJid, {
          text: '❌ Invalid command format. Usage: /getbitlocker <hostname>\n\nExample: /getbitlocker MTI-NB-177',
        });
        return;
      }

      const result = await getBitLockerInfo({ hostname });
      if (!result.success) {
        await sock.sendMessage(remoteJid, { text: `*Error:* ${result.error}` });
        return;
      }

      const { hostname: host, keys } = result.data;
      const lines: string[] = ['*BitLocker Recovery Keys*', `*Hostname:* ${host.toUpperCase()}`, `*Found:* ${keys.length}`, ''];

      keys.forEach((k, idx) => {
        const match = k.partitionId.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/);
        let formattedDate = 'Unknown';
        if (match) {
          const [, y, mo, d, h, mi, s] = match;
          const dt = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
          formattedDate = dt
            .toLocaleString('en-GB', {
            timeZone: 'Asia/Jakarta',
            day: '2-digit',
            month: 'short',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false,
          })
            .replace(',', '');
        }

        const guid = (k.partitionId.split('{')[1] || '').replace('}', '');
        const passwordId = guid.trim() ? guid : 'Unknown';

        lines.push(`*Key ${idx + 1}*`);
        lines.push(`• *Password ID:* ${passwordId}`);
        lines.push(`• *Created:* ${formattedDate} WIB`);
        lines.push(`• *Recovery Key:* ${k.password}`);
        if (idx < keys.length - 1) lines.push('');
      });

      await sock.sendMessage(remoteJid, { text: lines.join('\n') });
      return;
    }
    case '/technician': {
      const requester = getRequesterPhoneFromMessage(msg, remoteJid);
      if (!requester || (allowedPhoneNumbers.length > 0 && !allowedPhoneNumbers.includes(requester))) {
        await sock.sendMessage(remoteJid, { text: 'Access denied.' });
        return;
      }

      const tokens = splitCommandLine(messageContent);
      const sub = tokens[1]?.toLowerCase();
      if (!sub) {
        const helpText = renderCommandHelp('technician');
        await sock.sendMessage(remoteJid, { text: helpText ?? 'Usage: /technician <command>' });
        return;
      }

      if (sub === 'list') {
        const contacts = listTechnicianContacts();
        if (contacts.length === 0) {
          const contactsPath = getTechnicianContactsPath();
          await sock.sendMessage(remoteJid, {
            text:
              `No technicians found.\n\n` +
              `Storage: ${contactsPath}\n\n` +
              `Add one:\n` +
              `/technician add "Name" "ICT Name" "628xxxxxxxxxxx" "email@company.com" "Role" "Gender"`,
          });
          return;
        }

        await sock.sendMessage(remoteJid, {
          text: `*Technicians* (${contacts.length})\n\n${renderTechnicianTable(contacts)}`,
        });
        return;
      }

      if (sub === 'search') {
        const query = tokens.slice(2).join(' ').trim();
        if (!query) {
          await sock.sendMessage(remoteJid, { text: 'Usage: /technician search <query>' });
          return;
        }

        const results = searchTechnicianContacts(query);
        if (results.length === 0) {
          await sock.sendMessage(remoteJid, { text: 'No technicians matched your query.' });
          return;
        }

        await sock.sendMessage(remoteJid, {
          text: `*Technician Search Results*\nQuery: ${query}\nMatches: ${results.length}\n\n${renderTechnicianTable(results)}`,
        });
        return;
      }

      if (sub === 'view') {
        const idRaw = tokens[2];
        const id = idRaw ? Number(idRaw) : NaN;
        if (!Number.isFinite(id)) {
          await sock.sendMessage(remoteJid, { text: 'Usage: /technician view <id>' });
          return;
        }

        const contact = getTechnicianContactById(id);
        if (!contact) {
          await sock.sendMessage(remoteJid, { text: `Technician with id ${id} not found.` });
          return;
        }

        await sock.sendMessage(remoteJid, {
          text: `*Technician Details*\n\n${renderTechnicianDetails(contact)}`,
        });
        return;
      }

      if (sub === 'add') {
        const name = tokens[2];
        const ictName = tokens[3];
        const phone = tokens[4];
        const emailRaw = tokens[5];
        const technician = tokens[6];
        const gender = tokens[7];

        if (!name || !ictName || !phone || !emailRaw || !technician) {
          await sock.sendMessage(remoteJid, {
            text: 'Usage: /technician add "Name" "ICT Name" "Phone" "Email" "Role" "Gender"',
          });
          return;
        }

        const email = emailRaw.toLowerCase() === 'null' || emailRaw === '-' ? null : emailRaw;
        const created = addTechnicianContact({
          name,
          ict_name: ictName,
          phone,
          email,
          technician,
          gender: gender ? gender : null,
        });

        await sock.sendMessage(remoteJid, {
          text: `Technician added.\n\n${renderTechnicianDetails(created)}`,
        });
        return;
      }

      if (sub === 'update') {
        const idRaw = tokens[2];
        const fieldRaw = tokens[3];
        const value = tokens.slice(4).join(' ').trim();
        const id = idRaw ? Number(idRaw) : NaN;

        if (!Number.isFinite(id) || !fieldRaw || !value || !isUpdateField(fieldRaw)) {
          await sock.sendMessage(remoteJid, {
            text: 'Usage: /technician update <id> "field" "value" (fields: name, ict_name, phone, email, technician, gender)',
          });
          return;
        }

        const updated = updateTechnicianContact(id, fieldRaw, value);
        if (!updated) {
          await sock.sendMessage(remoteJid, { text: `Update failed for technician id ${id}.` });
          return;
        }

        await sock.sendMessage(remoteJid, {
          text: `Technician updated.\n\n${renderTechnicianDetails(updated)}`,
        });
        return;
      }

      if (sub === 'delete') {
        const idRaw = tokens[2];
        const id = idRaw ? Number(idRaw) : NaN;
        if (!Number.isFinite(id)) {
          await sock.sendMessage(remoteJid, { text: 'Usage: /technician delete <id>' });
          return;
        }

        const ok = deleteTechnicianContact(id);
        await sock.sendMessage(remoteJid, {
          text: ok ? `Technician id ${id} deleted.` : `Technician id ${id} not found.`,
        });
        return;
      }

      const helpText = renderCommandHelp('technician');
      await sock.sendMessage(remoteJid, { text: helpText ?? 'Unknown technician command.' });
      return;
    }
    default:
      return;
  }
}

export async function startWhatsApp(deps: StartWhatsAppDeps): Promise<void> {
  activeDeps = deps;
  messageBuffers.clear();
  presenceStatus.clear();
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

    const allowedReactionGroups = parseReactionGroupIds();

    for (const msg of payloadUnknown.messages) {
      if (msg.key?.fromMe) continue;
      const remoteJid = msg.key?.remoteJid;
      if (!remoteJid) continue;
      if (remoteJid === 'status@broadcast') continue;

      const parsed = await parseIncomingMessage({ sock: currentSock, msg });
      const messageContent = parsed.text;
      if (messageContent.startsWith('/')) {
        await handleCommand({
          sock: currentSock,
          msg,
          remoteJid,
          messageContent,
          allowedPhoneNumbers: deps.allowedPhoneNumbers,
        });
      } else {
        const isGroup = remoteJid.endsWith('@g.us');
        const shouldReply = !isGroup || isTaggedInGroup({ sock: currentSock, deps, msg, messageText: messageContent });
        const shouldLogOnly = !shouldReply && (!isGroup || process.env.LOG_UNTAGGED_GROUPS !== 'false');
        if (!shouldReply && !shouldLogOnly) continue;

        const senderNumber = resolveSenderNumber({ msg, remoteJid, store: deps.store, authInfoDir: deps.authInfoDir });
        const pushName = msg.pushName ?? 'Unknown';
        const buffered = addToMessageBuffer({
          msg,
          text: messageContent,
          attachments: parsed.attachments,
          remoteJid,
          senderNumber,
          pushName,
          isGroup,
          shouldReply,
          messageType: parsed.messageType,
          mentionedJids: parsed.mentionedJids,
          quotedMessage: parsed.quotedMessage,
        });

        if (buffered) continue;

        await handleMessage({
          sock: currentSock,
          msg,
          remoteJid,
          messageContent,
          attachments: parsed.attachments,
          messageType: parsed.messageType,
          mentionedJids: parsed.mentionedJids,
          quotedMessage: parsed.quotedMessage,
          shouldReply,
          deps,
        });
      }
    }
  });

  sock.ev.on('presence.update', async (payloadUnknown) => {
    if (!PRESENCE_BUFFER_ENABLED) return;
    const deps = activeDeps;
    if (!deps) return;
    const items = extractPresenceItems(payloadUnknown);
    if (items.length === 0) return;

    for (const item of items) {
      const resolvedParticipantJid = resolveParticipantJid({
        participant: item.participantJid,
        store: deps.store,
        authInfoDir: deps.authInfoDir,
      });

      const presenceKey = getBufferKey({ remoteJid: item.remoteJid, senderNumber: resolvedParticipantJid });
      const isTyping = isPresenceTyping(item.presence);
      presenceStatus.set(presenceKey, { isTyping, lastUpdateMs: Date.now() });

      const buffer = messageBuffers.get(presenceKey);
      if (!buffer) continue;
      buffer.isTyping = isTyping;

      if (isTyping) {
        scheduleFlush({ key: presenceKey, buffer, forceMaxTimeout: true });
      } else {
        if (buffer.typingTimer) clearTimeout(buffer.typingTimer);
        buffer.typingTimer = setTimeout(() => {
          void flushMessageBuffer(presenceKey);
        }, PRESENCE_BUFFER_STOP_DELAY_MS);
      }
    }
  });

  sock.ev.on('messages.reaction', async (payloadUnknown) => {
    const allowedGroups = parseReactionGroupIds();
    if (allowedGroups.size === 0) return;

    const items = Array.isArray(payloadUnknown) ? payloadUnknown : [payloadUnknown];

    const currentSock = sock;
    if (!currentSock) return;

    const sockUserJid = currentSock.user?.id;
    const sockDigits = typeof sockUserJid === 'string' ? extractPhoneDigitsFromJid(sockUserJid) : null;

    for (const itemUnknown of items) {
      if (!itemUnknown || typeof itemUnknown !== 'object') continue;
      const item = itemUnknown as {
        key?: { remoteJid?: unknown; id?: unknown; participant?: unknown };
        reaction?: { key?: { participant?: unknown }; text?: unknown };
      };

      const remoteJid = typeof item.key?.remoteJid === 'string' ? item.key.remoteJid : undefined;
      const messageId = typeof item.key?.id === 'string' ? item.key.id : undefined;
      if (!remoteJid || !messageId) continue;
      if (!allowedGroups.has(remoteJid)) continue;

      const participantRaw =
        typeof item.key?.participant === 'string'
          ? item.key.participant
          : typeof item.reaction?.key?.participant === 'string'
            ? item.reaction.key.participant
            : undefined;
      if (!participantRaw) continue;

      const reactionText =
        typeof item.reaction?.text === 'string' ? item.reaction.text : item.reaction?.text === null ? null : undefined;
      if (reactionText === undefined) continue;

      const participantJid = resolveParticipantJid({
        participant: participantRaw,
        store: deps.store,
        authInfoDir: deps.authInfoDir,
      });
      const participantDigits = extractPhoneDigitsFromJid(participantJid);
      if (sockDigits && participantDigits && participantDigits === sockDigits) continue;

      if (isReactionRemoved(reactionText)) {
        await handleTicketReactionUnclaim({
          sock: currentSock,
          deps,
          remoteJid,
          messageId,
          participantRaw,
        });
      } else {
        await handleTicketReactionClaim({
          sock: currentSock,
          deps,
          remoteJid,
          messageId,
          participantRaw,
        });
      }
    }
  });
}
