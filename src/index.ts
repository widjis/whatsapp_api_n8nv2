import express from 'express';
import { createServer } from 'node:http';
import { Server as SocketIoServer } from 'socket.io';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import multer from 'multer';
import dotenv from 'dotenv';
import { pino } from 'pino';
import { makeInMemoryStore } from './features/whatsapp/store.js';
import { startWhatsApp, getSocket, checkRegisteredNumber } from './features/whatsapp/start.js';
import { createCheckIpMiddleware } from './features/http/middleware/checkIp.js';
import { registerMessageRoutes } from './features/http/routes/messages.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

function resolveDataDir(rootDir: string): string | null {
  const raw = process.env.DATA_DIR;
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return path.isAbsolute(trimmed) ? trimmed : path.join(rootDir, trimmed);
}

const app = express();
const server = createServer(app);
const io = new SocketIoServer(server);

const portRaw = process.env.PORT;
const port = portRaw ? Number(portRaw) : 8192;
const n8nTimeoutMs = process.env.N8N_TIMEOUT ? Number(process.env.N8N_TIMEOUT) : 5000;

const allowedIps = (process.env.ALLOWED_IPS ?? '127.0.0.1,::1')
  .split(',')
  .map((ip) => ip.trim())
  .filter(Boolean);

const allowedPhoneNumbers = (process.env.ALLOWED_PHONE_NUMBERS ?? '')
  .split(',')
  .map((num) => num.trim())
  .filter(Boolean);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get('/', (req, res) => {
  res.sendFile(path.join(projectRoot, 'index.html'));
});

const dataDir = resolveDataDir(projectRoot);
if (dataDir && !fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const uploadsDir = path.join(dataDir ?? projectRoot, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (_req, file, cb) => {
    cb(null, file.originalname);
  },
});

const upload = multer({ storage });

const store = makeInMemoryStore({ logger: pino({ level: 'fatal' }) });
const storeFilePath = path.join(dataDir ?? projectRoot, 'baileys_store.json');
store.readFromFile(storeFilePath);

setInterval(() => {
  store.writeToFile(storeFilePath);
}, 10_000);

const checkIp = createCheckIpMiddleware({
  allowedIps,
  getSocket,
  alertReceiverJid: '6285712612218@s.whatsapp.net',
});

registerMessageRoutes({
  app,
  upload,
  checkIp,
  getSocket,
  checkRegisteredNumber,
});

server.listen(port, () => {
  console.log(`Server running on port ${port}`);
  const authInfoDir = path.join(dataDir ?? projectRoot, 'auth_info_baileys');
  if (!fs.existsSync(authInfoDir)) {
    fs.mkdirSync(authInfoDir, { recursive: true });
  }
  void startWhatsApp({
    io,
    store,
    authInfoDir,
    n8nWebhookUrl: process.env.N8N_WEBHOOK_URL,
    n8nTimeoutMs,
    allowedPhoneNumbers,
  });
});
