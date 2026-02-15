import type { Express, Request, Response } from 'express';
import { body, validationResult } from 'express-validator';
import type { Multer } from 'multer';
import type { AnyMessageContent, WASocket } from '@whiskeysockets/baileys';
import fs from 'node:fs';
import { delay, phoneNumberFormatter } from '../../whatsapp/utils.js';

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

async function findGroupIdByName(sock: WASocket, groupName: string): Promise<string | null> {
  const groups = await sock.groupFetchAllParticipating();
  const entries = Object.entries(groups);
  const needle = groupName.toLowerCase();
  const found = entries.find(([, group]) => {
    if (!group.subject) return false;
    return group.subject.toLowerCase().includes(needle);
  });
  return found ? found[0] : null;
}

async function resolveGroupChatId(args: { sock: WASocket; id?: string; name?: string }): Promise<string | null> {
  const id = args.id?.trim();
  const name = args.name?.trim();
  if (id && id.includes('@g.us')) return id;
  if (id && /^\d+$/.test(id)) return `${id}@g.us`;
  if (id) return await findGroupIdByName(args.sock, id);
  if (name) return await findGroupIdByName(args.sock, name);
  return null;
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
      const chatId = await resolveGroupChatId({ sock, id: body.id, name: body.name });
      if (!chatId) {
        const provided = body.id?.trim() || body.name?.trim() || '';
        res.status(422).json({ status: false, message: `No group found with name: ${provided}` });
        return;
      }

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
}
