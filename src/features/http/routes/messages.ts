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
}
