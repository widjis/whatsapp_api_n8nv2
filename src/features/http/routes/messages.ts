import type { Express, Request, Response } from 'express';
import { body, validationResult } from 'express-validator';
import type { Multer } from 'multer';
import type { AnyMessageContent, WASocket } from '@whiskeysockets/baileys';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import OpenAI from 'openai';
import { Redis as IORedis } from 'ioredis';
import { delay, phoneNumberFormatter } from '../../whatsapp/utils.js';
import {
  assignTechnicianToRequest,
  defineServiceCategory,
  handleAndAnalyzeAttachments,
  updateRequest,
  viewRequest,
  type ServiceDeskRequest,
} from '../../integrations/ticketHandle.js';
import { getContactByIctTechnicianName } from '../../integrations/technicianContacts.js';
import { findUserMobileByEmail } from '../../integrations/ldap.js';
import { storeTicketNotification } from '../../tickets/claimStore.js';

export type RegisterMessageRoutesDeps = {
  app: Express;
  upload: Multer;
  checkIp: (req: Request, res: Response, next: () => void) => void | Promise<void>;
  getSocket: () => WASocket | undefined;
  checkRegisteredNumber: (jid: string) => Promise<boolean>;
};

type SendMessageBody = {
  number: string;
  message?: string;
  imageUrl?: string;
  imageBuffer?: string;
};

type SendBulkMessageBody = {
  message: string;
  numbers: string[];
  minDelay: number;
  maxDelay: number;
};

type SendGroupMessageBody = {
  id?: string;
  name?: string;
  message?: string;
  mention?: string;
};

type UploadedFile = {
  path: string;
  originalname: string;
  mimetype?: string;
};

type WebhookBody = {
  id: string;
  status: 'new' | 'updated';
  receiver: string;
  receiver_type: string;
  notify_requester_new?: string;
  notify_requester_update?: string;
  notify_requester_assign?: string;
  notify_technician?: string;
};

type TicketState = {
  technician?: string;
  ticketStatus?: string;
  priority?: string;
};

const inMemoryTicketState = new Map<string, TicketState>();
let redisClient: IORedis | null | undefined;

function getRedisClient(): IORedis | null {
  if (redisClient !== undefined) return redisClient;
  const host = process.env.REDIS_HOST ?? '10.60.10.46';
  const portRaw = process.env.REDIS_PORT ?? '6379';
  const port = Number(portRaw);
  if (!Number.isFinite(port)) {
    redisClient = null;
    return null;
  }

  const client = new IORedis({ host, port, lazyConnect: true, maxRetriesPerRequest: 1 });
  client.on('error', (err: Error) => {
    console.error('Redis error:', err);
  });
  redisClient = client;
  return client;
}

function buildTicketStateKey(ticketId: string): string {
  return `ticket:${ticketId}`;
}

function safeParseTicketState(raw: string | null): TicketState | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const record = parsed as Record<string, unknown>;
    const technician = typeof record.technician === 'string' ? record.technician : undefined;
    const ticketStatus = typeof record.ticketStatus === 'string' ? record.ticketStatus : undefined;
    const priority = typeof record.priority === 'string' ? record.priority : undefined;
    return { technician, ticketStatus, priority };
  } catch {
    return null;
  }
}

async function loadPreviousTicketState(ticketId: string): Promise<TicketState | null> {
  const redis = getRedisClient();
  if (!redis) return inMemoryTicketState.get(ticketId) ?? null;
  try {
    await redis.connect();
    const raw = await redis.get(buildTicketStateKey(ticketId));
    return safeParseTicketState(raw);
  } catch {
    return inMemoryTicketState.get(ticketId) ?? null;
  }
}

async function saveTicketState(ticketId: string, state: TicketState): Promise<void> {
  inMemoryTicketState.set(ticketId, state);
  const redis = getRedisClient();
  if (!redis) return;
  try {
    await redis.connect();
    await redis.set(buildTicketStateKey(ticketId), JSON.stringify(state));
  } catch {
    return;
  }
}

function isWebhookBody(input: unknown): input is WebhookBody {
  if (!input || typeof input !== 'object') return false;
  const r = input as Record<string, unknown>;
  if (typeof r.id !== 'string' || r.id.trim().length < 1) return false;
  if (r.status !== 'new' && r.status !== 'updated') return false;
  if (typeof r.receiver !== 'string' || r.receiver.trim().length < 1) return false;
  if (typeof r.receiver_type !== 'string' || r.receiver_type.trim().length < 1) return false;
  return true;
}

function shouldNotify(raw: string | undefined): boolean {
  return raw === 'true';
}

function shouldNotifyWebhook(raw: string | undefined, defaultValue: boolean): boolean {
  if (!raw) return defaultValue;
  return raw === 'true';
}

function stripHtmlToText(value: string): string {
  const dom = new JSDOM(value);
  const text = dom.window.document.body.textContent ?? '';
  return text.replace(/\s+/g, ' ').trim();
}

function computeServiceDeskHostBaseUrl(): string {
  const rawApiBase = process.env.SD_BASE_URL ?? '';
  const apiBaseUrl = rawApiBase.endsWith('/') ? rawApiBase.slice(0, -1) : rawApiBase;
  return apiBaseUrl.endsWith('/api/v3') ? apiBaseUrl.slice(0, -'/api/v3'.length) : apiBaseUrl;
}

function buildTicketLink(ticketId: string): string {
  const hostBaseUrl = computeServiceDeskHostBaseUrl();
  const base = hostBaseUrl.endsWith('/') ? hostBaseUrl.slice(0, -1) : hostBaseUrl;
  return `${base}/WorkOrder.do?woMode=viewWO&woID=${encodeURIComponent(ticketId)}`;
}

function renderKeyValueLines(rows: Array<{ label: string; value: string }>): string {
  return rows.map((r) => `${r.label}: ${r.value}`).join('\n');
}

function renderTicketNewMessage(args: {
  requesterLabel: string;
  createdDate: string;
  ticketId: string;
  category: string;
  priority: string;
  status: string;
  subject: string;
  description: string;
  link: string;
}): string {
  const header = `*New request from ${args.requesterLabel} on ${args.createdDate}*`;
  const details = renderKeyValueLines([
    { label: 'Ticket ID', value: args.ticketId },
    { label: 'Status', value: args.status },
    { label: 'Priority', value: args.priority },
    { label: 'Category', value: args.category },
    { label: 'Subject', value: args.subject },
    { label: 'Description', value: args.description },
    { label: 'Link', value: args.link },
  ]);
  return `${header}\n\n${details}`;
}

function renderTicketUpdateMessage(args: {
  ticketId: string;
  requesterLabel: string;
  category: string;
  priority: string;
  status: string;
  subject: string;
  link: string;
  changes: string[];
}): string {
  const header = '*Ticket Updated*';
  const base = renderKeyValueLines([
    { label: 'Ticket ID', value: args.ticketId },
    { label: 'Requester', value: args.requesterLabel },
    { label: 'Status', value: args.status },
    { label: 'Priority', value: args.priority },
    { label: 'Category', value: args.category },
    { label: 'Subject', value: args.subject },
  ]);
  const changeLines = args.changes.length > 0 ? `\n\nChanges:\n${args.changes.map((c) => `- ${c}`).join('\n')}` : '';
  return `${header}\n\n${base}${changeLines}\n\nLink: ${args.link}`;
}

function renderTicketAssignedToTechnicianMessage(args: {
  ticketId: string;
  requesterLabel: string;
  category: string;
  priority: string;
  status: string;
  subject: string;
  description: string;
  link: string;
}): string {
  const header = '*Ticket assigned to you*';
  const details = renderKeyValueLines([
    { label: 'Ticket ID', value: args.ticketId },
    { label: 'Requester', value: args.requesterLabel },
    { label: 'Status', value: args.status },
    { label: 'Priority', value: args.priority },
    { label: 'Category', value: args.category },
    { label: 'Subject', value: args.subject },
    { label: 'Description', value: args.description },
    { label: 'Link', value: args.link },
  ]);
  return `${header}\n\n${details}`;
}

function renderRequesterTicketCreatedMessage(args: {
  requesterLabel: string;
  ticketId: string;
  status: string;
  priority: string;
  category: string;
  subject: string;
  description: string;
  link: string;
}): string {
  const header = `Dear *${args.requesterLabel}*,`;
  const intro = `Your request has been created successfully.`;
  const details = renderKeyValueLines([
    { label: 'Ticket ID', value: args.ticketId },
    { label: 'Status', value: args.status },
    { label: 'Priority', value: args.priority },
    { label: 'Category', value: args.category },
    { label: 'Subject', value: args.subject },
    { label: 'Description', value: args.description },
    { label: 'Link', value: args.link },
  ]);
  return `${header}\n\n${intro}\n\n${details}\n\nThank you.`;
}

function renderRequesterTicketUpdatedMessage(args: {
  requesterLabel: string;
  ticketId: string;
  link: string;
  changes: string[];
}): string {
  const header = `Dear *${args.requesterLabel}*,`;
  const intro = `Your ticket has been updated.`;
  const details = renderKeyValueLines([{ label: 'Ticket ID', value: args.ticketId }]);
  const changeLines = args.changes.length > 0 ? `\n\nChanges:\n${args.changes.map((c) => `- ${c}`).join('\n')}` : '';
  return `${header}\n\n${intro}\n\n${details}${changeLines}\n\nLink: ${args.link}`;
}

function renderRequesterTicketAssignedMessage(args: {
  requesterLabel: string;
  ticketId: string;
  assigneeName: string;
  link: string;
}): string {
  const header = `Dear *${args.requesterLabel}*,`;
  const intro = `Your ticket has been assigned to *${args.assigneeName}*.`;
  const details = renderKeyValueLines([{ label: 'Ticket ID', value: args.ticketId }]);
  return `${header}\n\n${intro}\n\n${details}\n\nLink: ${args.link}`;
}

async function truncateDescription(args: { text: string; maxChars: number }): Promise<string> {
  const { text, maxChars } = args;
  if (text.length <= maxChars) return text;

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return `${text.slice(0, Math.max(0, maxChars - 3))}...`;

  const client = new OpenAI({ apiKey });
  const prompt =
    `Truncate the following ticket description to ${maxChars} characters or fewer. ` +
    `Preserve the key meaning. Do not add extra info. Output only the truncated text.\n\n` +
    text;

  try {
    const response = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 200,
      temperature: 0.2,
    });

    const content = response.choices[0]?.message?.content ?? '';
    const trimmed = content.trim();
    if (!trimmed) return `${text.slice(0, Math.max(0, maxChars - 3))}...`;
    return trimmed.length <= maxChars ? trimmed : `${trimmed.slice(0, Math.max(0, maxChars - 3))}...`;
  } catch {
    return `${text.slice(0, Math.max(0, maxChars - 3))}...`;
  }
}

function determineGroupByTechnicianRole(role: string): string {
  const r = role.toLowerCase();
  if (r.includes('document control')) return 'ICT Document Controller';
  if (r.includes('it field support')) return 'ICT Network and Infrastructure';
  if (r.includes('it support')) return 'ICT System and Support';
  return 'ICT System and Support';
}

function getRequesterLabel(request: ServiceDeskRequest): string {
  const name = request.requester?.name?.trim();
  const email = request.requester?.email_id?.trim();
  if (name && email) return `${name} (${email})`;
  if (name) return name;
  if (email) return email;
  return 'Unknown requester';
}

async function resolveRequesterMobile(request: ServiceDeskRequest): Promise<string | null> {
  const direct = request.requester?.mobile;
  if (direct && direct.trim().length > 0) return direct;
  const email = request.requester?.email_id;
  if (!email) return null;
  return await findUserMobileByEmail({ email });
}

function pickUploadedFile(files: unknown, fieldName: string): UploadedFile | undefined {
  if (!files || typeof files !== 'object') return undefined;
  const record = files as Record<string, unknown>;
  const entry = record[fieldName];
  if (!Array.isArray(entry) || entry.length < 1) return undefined;
  const first = entry[0];
  if (!first || typeof first !== 'object') return undefined;
  const fileRecord = first as Record<string, unknown>;
  const filePath = fileRecord.path;
  const originalname = fileRecord.originalname;
  if (typeof filePath !== 'string' || typeof originalname !== 'string') return undefined;
  const mimetype = typeof fileRecord.mimetype === 'string' ? fileRecord.mimetype : undefined;
  return { path: filePath, originalname, mimetype };
}

function ensureMentionJid(value: string): string {
  const trimmed = value.trim();
  if (trimmed.includes('@')) return trimmed;
  return `${trimmed}@s.whatsapp.net`;
}

function parseMentionedJids(raw: unknown): string[] {
  if (typeof raw !== 'string' || raw.trim().length < 1) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const mapped = parsed
      .map((item): string | null => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object') {
          const record = item as Record<string, unknown>;
          if (typeof record.jid === 'string') return record.jid;
          if (typeof record.phone === 'string') return record.phone;
        }
        return null;
      })
      .filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
    return mapped.map(ensureMentionJid);
  } catch {
    return [];
  }
}

type GroupCacheEntry = {
  id: string;
  subject: string;
  subjectLower: string;
};

type GroupCache = {
  fetchedAtMs: number;
  entries: GroupCacheEntry[];
};

type GroupResolveResult =
  | { ok: true; chatId: string }
  | { ok: false; reason: 'not_found' | 'rate_limited' | 'error'; message: string };

let groupCache: GroupCache | null = null;
let groupCacheInFlight: Promise<GroupCache | null> | null = null;
let groupCacheBlockedUntilMs = 0;

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  if (n <= 0) return fallback;
  return Math.floor(n);
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function getErrorDataCode(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null;
  const record = error as Record<string, unknown>;
  const data = record.data;
  if (typeof data === 'number' && Number.isFinite(data)) return data;
  return null;
}

function isRateOverlimit(error: unknown): boolean {
  const msg = getErrorMessage(error).toLowerCase();
  if (msg.includes('rate-overlimit')) return true;
  return getErrorDataCode(error) === 429;
}

async function fetchGroupCache(sock: WASocket): Promise<GroupCache> {
  const groupsUnknown = await sock.groupFetchAllParticipating();
  const groups = groupsUnknown as unknown as Record<string, { subject?: unknown }>;
  const entries: GroupCacheEntry[] = [];
  for (const [id, meta] of Object.entries(groups)) {
    const subject = typeof meta?.subject === 'string' ? meta.subject : '';
    if (!subject) continue;
    entries.push({ id, subject, subjectLower: subject.toLowerCase() });
  }
  return { fetchedAtMs: Date.now(), entries };
}

async function getGroupCache(sock: WASocket): Promise<GroupCache | null> {
  const ttlMs = readPositiveIntEnv('GROUP_CACHE_TTL_MS', 5 * 60 * 1000);
  const backoffMs = readPositiveIntEnv('GROUP_CACHE_BACKOFF_MS', 60 * 1000);
  const now = Date.now();

  if (groupCache && now - groupCache.fetchedAtMs <= ttlMs) return groupCache;
  if (now < groupCacheBlockedUntilMs) return groupCache;

  if (groupCacheInFlight) return await groupCacheInFlight;

  groupCacheInFlight = (async () => {
    try {
      const fetched = await fetchGroupCache(sock);
      groupCache = fetched;
      return fetched;
    } catch (error) {
      if (isRateOverlimit(error)) {
        groupCacheBlockedUntilMs = Date.now() + backoffMs;
        return groupCache;
      }
      return groupCache;
    } finally {
      groupCacheInFlight = null;
    }
  })();

  return await groupCacheInFlight;
}

async function resolveGroupChatId(args: { sock: WASocket; id?: string; name?: string }): Promise<GroupResolveResult> {
  const id = args.id?.trim();
  const name = args.name?.trim();

  if (id && id.includes('@g.us')) return { ok: true, chatId: id };
  if (id && /^\d+$/.test(id)) return { ok: true, chatId: `${id}@g.us` };

  const query = (id || name || '').trim();
  if (!query) return { ok: false, reason: 'not_found', message: 'Missing group id or name' };

  const now = Date.now();
  const cached = await getGroupCache(args.sock);
  const needle = query.toLowerCase();
  const foundCached = cached?.entries.find((entry) => entry.subjectLower.includes(needle));
  if (foundCached) return { ok: true, chatId: foundCached.id };

  if (now < groupCacheBlockedUntilMs) {
    return { ok: false, reason: 'rate_limited', message: 'WhatsApp group lookup rate limited. Try again later.' };
  }

  try {
    const fetched = await fetchGroupCache(args.sock);
    groupCache = fetched;
    const foundFresh = fetched.entries.find((entry) => entry.subjectLower.includes(needle));
    if (foundFresh) return { ok: true, chatId: foundFresh.id };
    return { ok: false, reason: 'not_found', message: `No group found with name: ${query}` };
  } catch (error) {
    if (isRateOverlimit(error)) {
      const backoffMs = readPositiveIntEnv('GROUP_CACHE_BACKOFF_MS', 60 * 1000);
      groupCacheBlockedUntilMs = Date.now() + backoffMs;
      return { ok: false, reason: 'rate_limited', message: 'WhatsApp group lookup rate limited. Try again later.' };
    }
    return { ok: false, reason: 'error', message: `Failed to lookup group: ${getErrorMessage(error)}` };
  }
}

function normalizeReceiverJid(receiver: string): string {
  const trimmed = receiver.trim();
  if (trimmed.includes('@')) return trimmed;
  return phoneNumberFormatter(trimmed);
}

function resolveDocumentMimeType(file: UploadedFile): string {
  if (file.originalname.toLowerCase().endsWith('.xlsx')) {
    return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  }
  if (file.originalname.toLowerCase().endsWith('.pdf')) {
    return 'application/pdf';
  }
  return file.mimetype ?? 'application/octet-stream';
}

async function sendTextMessage(args: { number: string; message: string; sock: WASocket }) {
  const formattedNumber = phoneNumberFormatter(args.number);
  const response = await args.sock.sendMessage(formattedNumber, { text: args.message });
  console.log(`Message sent to ${formattedNumber}:`, response);
  return response;
}

export function registerMessageRoutes(deps: RegisterMessageRoutesDeps) {
  deps.app.post(
    '/send-message',
    deps.checkIp,
    deps.upload.single('image'),
    [
      body('number').trim().notEmpty().withMessage('Number cannot be empty'),
      body('message')
        .trim()
        .custom((v, { req }) => {
          const r = req as Request;
          const hasText = typeof v === 'string' && v.trim().length > 0;
          const hasFile = Boolean((r as Request & { file?: unknown }).file);
          const bodyUnknown = r.body as unknown;
          const bodyObj = bodyUnknown && typeof bodyUnknown === 'object' ? (bodyUnknown as Record<string, unknown>) : {};
          const hasImageUrl = typeof bodyObj.imageUrl === 'string' && bodyObj.imageUrl.length > 0;
          const hasImageBuffer = typeof bodyObj.imageBuffer === 'string' && bodyObj.imageBuffer.length > 0;
          if (!hasText && !hasFile && !hasImageUrl && !hasImageBuffer) {
            throw new Error('Either message text or image (file, URL, or buffer) must be provided');
          }
          return true;
        }),
      body('imageBuffer')
        .optional()
        .custom((value) => {
          if (value !== undefined && typeof value !== 'string') {
            throw new Error('imageBuffer must be a base64 encoded string');
          }
          return true;
        }),
    ],
    async (req: Request, res: Response) => {
      const errors = validationResult(req).formatWith((error) => error.msg);
      if (!errors.isEmpty()) {
        res.status(422).json({ status: false, errors: errors.mapped() });
        return;
      }

      const sock = deps.getSocket();
      if (!sock) {
        res.status(503).json({ status: false, message: 'WhatsApp socket is not initialized.' });
        return;
      }

      const body = req.body as SendMessageBody;
      const jid = phoneNumberFormatter(body.number);
      if (!(await deps.checkRegisteredNumber(jid))) {
        res.status(422).json({ status: false, message: 'The number is not registered' });
        return;
      }

      let payload: AnyMessageContent;
      if (req.file) {
        const fileBuffer = await fs.promises.readFile(req.file.path);
        payload = { image: fileBuffer, caption: body.message ?? '' };
      } else if (body.imageBuffer) {
        try {
          const imageBuffer = Buffer.from(body.imageBuffer, 'base64');
          payload = { image: imageBuffer, caption: body.message ?? '' };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          res.status(422).json({ status: false, message: 'Invalid base64 imageBuffer format', error: message });
          return;
        }
      } else if (body.imageUrl) {
        payload = { image: { url: body.imageUrl }, caption: body.message ?? '' };
      } else {
        payload = { text: body.message ?? '' };
      }

      try {
        const response = await sock.sendMessage(jid, payload);
        res.status(200).json({ status: true, response });
      } catch (error) {
        console.error('Error sending message:', error);
        res.status(500).json({ status: false, error: String(error) });
      }
    }
  );

  deps.app.post(
    '/send-bulk-message',
    deps.checkIp,
    async (req: Request, res: Response) => {
      const sock = deps.getSocket();
      if (!sock) {
        res.status(503).json({ status: false, message: 'WhatsApp socket is not initialized.' });
        return;
      }

      const body = req.body as SendBulkMessageBody;
      const { message, numbers, minDelay, maxDelay } = body;

      if (!message || !numbers) {
        res.status(400).json({ status: false, message: 'Message and numbers are required.' });
        return;
      }

      if (!minDelay || !maxDelay) {
        res.status(400).json({ status: false, message: 'Minimum and maximum delay are required.' });
        return;
      }

      try {
        console.log('Received numbers array:', numbers);

        for (const number of numbers) {
          console.log('Sending message to:', number);
          await sendTextMessage({ number, message, sock });
          const delayDuration = Math.floor(Math.random() * (maxDelay - minDelay + 1)) + minDelay;
          console.log(`Waiting for ${delayDuration} miliseconds before sending the next message.`);
          await delay(delayDuration);
        }

        res.status(200).json({ status: true, message: 'Messages sent successfully.' });
      } catch (error) {
        const messageText = error instanceof Error ? error.message : String(error);
        console.error('Error sending bulk messages:', error);
        res.status(500).json({ status: false, message: messageText });
      }
    }
  );

  deps.app.post(
    '/send-group-message',
    deps.checkIp,
    deps.upload.fields([
      { name: 'document', maxCount: 1 },
      { name: 'image', maxCount: 1 },
    ]),
    [
      body('id').custom((value, { req }) => {
        const r = req as Request;
        const bodyUnknown = r.body as unknown;
        const bodyObj = bodyUnknown && typeof bodyUnknown === 'object' ? (bodyUnknown as Record<string, unknown>) : {};
        if (!value && typeof bodyObj.name !== 'string') {
          throw new Error('Invalid value, you can use `id` or `name`');
        }
        return true;
      }),
      body('message').optional().notEmpty().withMessage('Message cannot be empty'),
    ],
    async (req: Request, res: Response) => {
      const errors = validationResult(req).formatWith((error) => error.msg);
      if (!errors.isEmpty()) {
        res.status(422).json({ status: false, message: errors.mapped() });
        return;
      }

      const sock = deps.getSocket();
      if (!sock) {
        res.status(503).json({ status: false, message: 'WhatsApp socket is not initialized.' });
        return;
      }

      const body = req.body as SendGroupMessageBody;
      const mentionedJids = parseMentionedJids(body.mention);
      const resolved = await resolveGroupChatId({ sock, id: body.id, name: body.name });
      if (!resolved.ok) {
        const statusCode = resolved.reason === 'rate_limited' ? 429 : resolved.reason === 'error' ? 503 : 422;
        res.status(statusCode).json({ status: false, message: resolved.message });
        return;
      }
      const chatId = resolved.chatId;

      const filesUnknown = (req as Request & { files?: unknown }).files;
      const document = pickUploadedFile(filesUnknown, 'document');
      const image = pickUploadedFile(filesUnknown, 'image');

      try {
        if (document) {
          const buffer = await fs.promises.readFile(document.path);
          try {
            const response = await sock.sendMessage(chatId, {
              document: buffer,
              mimetype: resolveDocumentMimeType(document),
              fileName: document.originalname,
              caption: body.message ?? '',
              mentions: mentionedJids,
            });
            res.status(200).json({ status: true, response });
          } finally {
            await fs.promises.unlink(document.path).catch(() => undefined);
          }
          return;
        }

        if (image) {
          const buffer = await fs.promises.readFile(image.path);
          try {
            const response = await sock.sendMessage(chatId, {
              image: buffer,
              caption: body.message ?? '',
              mentions: mentionedJids,
            });
            res.status(200).json({ status: true, response });
          } finally {
            await fs.promises.unlink(image.path).catch(() => undefined);
          }
          return;
        }

        const response = await sock.sendMessage(chatId, {
          text: body.message ?? 'Hello',
          mentions: mentionedJids,
        });
        res.status(200).json({ status: true, response });
      } catch (error) {
        res.status(500).json({ status: false, response: String(error) });
      }
    }
  );

  deps.app.post('/webhook', deps.checkIp, async (req: Request, res: Response) => {
    const bodyUnknown = req.body as unknown;
    if (!isWebhookBody(bodyUnknown)) {
      res.status(400).json({ error: 'Invalid payload' });
      return;
    }

    const payload = bodyUnknown;
    const sock = deps.getSocket();
    if (!sock) {
      res.status(503).json({ status: false, message: 'WhatsApp socket is not initialized.' });
      return;
    }

    try {
      const requestObj = await viewRequest(payload.id);
      if (!requestObj) {
        res.status(404).json({ error: 'Request not found' });
        return;
      }

      const receiverJid = normalizeReceiverJid(payload.receiver);
      const createdBy = getRequesterLabel(requestObj);
      const createdDate = requestObj.created_time?.display_value ?? 'N/A';
      const category = requestObj.service_category?.name ?? 'N/A';
      const ticketStatus = requestObj.status?.name ?? 'N/A';
      const priority = requestObj.priority?.name ?? 'N/A';
      const subject = requestObj.subject ?? 'No subject';
      const descriptionPlain = stripHtmlToText(requestObj.description ?? '');
      const truncatedDescription = await truncateDescription({ text: descriptionPlain, maxChars: 200 });
      const ticketLink = buildTicketLink(requestObj.id);

      const requesterMobile = await resolveRequesterMobile(requestObj);
      const requesterJid = requesterMobile ? phoneNumberFormatter(requesterMobile) : null;

      if (payload.status === 'new') {
        let categoryForMessage = category;
        let priorityForMessage = priority;
        const currentTemplateId = requestObj.template?.id ?? null;
        const shouldConvertTemplate = currentTemplateId !== '305';
        const shouldSuggestCategory = category === 'N/A' || category.trim().length === 0;
        const shouldSetPriorityLow = priority === 'N/A' || priority.trim().length === 0;

        const updateArgs: {
          templateId?: string;
          templateName?: string;
          isServiceTemplate?: boolean;
          serviceCategory?: string;
          priority?: string;
        } = {};

        if (shouldConvertTemplate) {
          updateArgs.templateId = '305';
          updateArgs.templateName = 'Submit a New Request';
          updateArgs.isServiceTemplate = false;
        }

        if (shouldSuggestCategory) {
          const suggestedCategory = await defineServiceCategory(requestObj.id);
          if (suggestedCategory) {
            updateArgs.serviceCategory = suggestedCategory;
          }
        }

        if (shouldSetPriorityLow) {
          updateArgs.priority = 'Low';
        }

        if (updateArgs.serviceCategory || updateArgs.templateId || updateArgs.priority) {
          const updateRes = await updateRequest(requestObj.id, updateArgs);
          if (updateRes.success) {
            if (updateArgs.serviceCategory) categoryForMessage = updateArgs.serviceCategory;
            if (updateArgs.priority) priorityForMessage = updateArgs.priority;
          } else {
            console.warn(`Ticket update (new) failed for ${requestObj.id}: ${updateRes.message}`);
          }
        }

        const msgReceiver = renderTicketNewMessage({
          requesterLabel: createdBy,
          createdDate,
          ticketId: requestObj.id,
          category: categoryForMessage,
          priority: priorityForMessage,
          status: ticketStatus,
          subject,
          description: truncatedDescription,
          link: ticketLink,
        });

        const sentUnknown: unknown = await sock.sendMessage(receiverJid, { text: msgReceiver });
        const sent = sentUnknown as { key?: { id?: unknown; remoteJid?: unknown } };
        const messageId = typeof sent.key?.id === 'string' ? sent.key.id : undefined;
        const remoteJid = typeof sent.key?.remoteJid === 'string' ? sent.key.remoteJid : receiverJid;
        if (messageId) {
          await storeTicketNotification({ ticketId: requestObj.id, remoteJid, messageId });
        }

        const notifyRequesterNew = shouldNotifyWebhook(payload.notify_requester_new, true);
        if (requesterJid && notifyRequesterNew) {
          const msgRequester = renderRequesterTicketCreatedMessage({
            requesterLabel: createdBy,
            ticketId: requestObj.id,
            status: ticketStatus,
            priority: priorityForMessage,
            category: categoryForMessage,
            subject,
            description: truncatedDescription,
            link: ticketLink,
          });
          await sock.sendMessage(requesterJid, { text: msgRequester });
        }

        if ((requestObj.attachments?.length ?? 0) > 0) {
          await handleAndAnalyzeAttachments(requestObj);
        }

        await saveTicketState(requestObj.id, {
          technician: requestObj.udf_fields?.udf_pick_601,
          ticketStatus,
          priority: priorityForMessage,
        });

        res.status(200).json({ message: 'Notification sent successfully' });
        return;
      }

      let categoryForMessage = category;
      let priorityForMessage = priority;
      const shouldSuggestCategory = category === 'N/A' || category.trim().length === 0;
      const shouldSetPriorityLow = priority === 'N/A' || priority.trim().length === 0;

      const updateArgs: {
        serviceCategory?: string;
        priority?: string;
      } = {};

      if (shouldSuggestCategory) {
        const suggestedCategory = await defineServiceCategory(requestObj.id);
        if (suggestedCategory) updateArgs.serviceCategory = suggestedCategory;
      }

      if (shouldSetPriorityLow) {
        updateArgs.priority = 'Low';
      }

      if (updateArgs.serviceCategory || updateArgs.priority) {
        const updateRes = await updateRequest(requestObj.id, updateArgs);
        if (updateRes.success) {
          if (updateArgs.serviceCategory) categoryForMessage = updateArgs.serviceCategory;
          if (updateArgs.priority) priorityForMessage = updateArgs.priority;
        } else {
          console.warn(`Ticket update (updated) failed for ${requestObj.id}: ${updateRes.message}`);
        }
      }

      const previousState = await loadPreviousTicketState(requestObj.id);
      const currentTechnician = requestObj.udf_fields?.udf_pick_601;

      const changes: string[] = [];
      if (previousState?.ticketStatus && previousState.ticketStatus !== ticketStatus) {
        changes.push(`Status: ${previousState.ticketStatus} → ${ticketStatus}`);
      } else {
        changes.push(`Status: ${ticketStatus}`);
      }

      if (previousState?.priority && previousState.priority !== priority) {
        changes.push(`Priority: ${previousState.priority} → ${priority}`);
      } else {
        changes.push(`Priority: ${priority}`);
      }

      if (previousState?.technician && previousState.technician !== (currentTechnician ?? '')) {
        changes.push(`Technician: ${previousState.technician} → ${currentTechnician ?? 'Unassigned'}`);
      } else if (currentTechnician) {
        changes.push(`Technician: ${currentTechnician}`);
      }

      const msgReceiverUpdate = renderTicketUpdateMessage({
        ticketId: requestObj.id,
        requesterLabel: createdBy,
        category: categoryForMessage,
        priority: priorityForMessage,
        status: ticketStatus,
        subject,
        link: ticketLink,
        changes,
      });
      await sock.sendMessage(receiverJid, { text: msgReceiverUpdate });

      if (requesterJid && shouldNotify(payload.notify_requester_update)) {
        const msgRequesterUpdate = renderRequesterTicketUpdatedMessage({
          requesterLabel: createdBy,
          ticketId: requestObj.id,
          link: ticketLink,
          changes,
        });
        await sock.sendMessage(requesterJid, { text: msgRequesterUpdate });
      }

      if (
        currentTechnician &&
        currentTechnician !== 'ICT Helpdesk' &&
        previousState?.technician !== currentTechnician &&
        shouldNotify(payload.notify_technician)
      ) {
        const technicianContact = getContactByIctTechnicianName(currentTechnician);
        if (technicianContact) {
          const groupName = determineGroupByTechnicianRole(technicianContact.technician);
          await assignTechnicianToRequest({
            requestId: requestObj.id,
            groupName,
            technicianName: technicianContact.technician,
          });

          const technicianJid = phoneNumberFormatter(technicianContact.phone);
          const msgTechnician = renderTicketAssignedToTechnicianMessage({
            ticketId: requestObj.id,
            requesterLabel: createdBy,
            category: categoryForMessage,
            priority: priorityForMessage,
            status: ticketStatus,
            subject,
            description: truncatedDescription,
            link: ticketLink,
          });
          await sock.sendMessage(technicianJid, { text: msgTechnician });

          if (requesterJid && shouldNotify(payload.notify_requester_assign)) {
            const msgRequesterAssign = renderRequesterTicketAssignedMessage({
              requesterLabel: createdBy,
              ticketId: requestObj.id,
              assigneeName: technicianContact.name,
              link: ticketLink,
            });
            await sock.sendMessage(requesterJid, { text: msgRequesterAssign });
          }
        }
      }

      if ((requestObj.attachments?.length ?? 0) > 0) {
        await handleAndAnalyzeAttachments(requestObj);
      }

      await saveTicketState(requestObj.id, {
        technician: currentTechnician,
        ticketStatus,
        priority: priorityForMessage,
      });

      res.status(200).json({ message: 'Notification sent successfully' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('Error processing webhook:', message);
      res.status(500).json({ error: 'Failed to process webhook' });
    }
  });
}
