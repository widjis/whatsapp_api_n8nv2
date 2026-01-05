import {
    makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    Browsers,
    makeCacheableSignalKeyStore,
    jidNormalizedUser
} from '@whiskeysockets/baileys';
import { makeInMemoryStore } from './store.js';
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import Pino from 'pino';
import qrcode from 'qrcode';

import path from 'path';
import { fileURLToPath } from 'url';
import { readFileSync, existsSync } from 'fs';
import fs from 'fs';
import multer from 'multer';
import { body, validationResult } from 'express-validator';
import dotenv from 'dotenv';
import https from 'https';
import { URL } from 'url';
import ldap from 'ldapjs';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 8192;
const N8N_TIMEOUT = parseInt(process.env.N8N_TIMEOUT) || 5000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve the existing index.html file
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

let sock;
const store = makeInMemoryStore({ logger: Pino({ level: "fatal" }) });
store.readFromFile('./baileys_store.json');

// Save store every 10s
setInterval(() => {
    store.writeToFile('./baileys_store.json');
}, 10_000);

// Helper function to introduce delay
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

const phoneNumberFormatter = (number) => {
    let formatted = number.toString();
    if (formatted.endsWith('@s.whatsapp.net')) {
        return formatted;
    }
    formatted = formatted.replace(/\D/g, '');
    if (formatted.startsWith('0')) {
        formatted = '62' + formatted.slice(1);
    }
    return formatted + '@s.whatsapp.net';
};

const checkRegisteredNumber = async (number) => {
  if (!sock) {
      console.error('WhatsApp socket is not initialized.');
      return false;
  }
  try {
      const [result] = await sock.onWhatsApp(number);
      return result?.exists;
  } catch (error) {
      console.error('Error checking registered number:', error);
      return false;
  }
};

// Set up multer storage
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
      cb(null, 'uploads/');
  },
  filename: (req, file, cb) => {
      cb(null, file.originalname);
  }
});
const upload = multer({ storage: storage });

// Helper function to send a message
async function sendMessage(number, message) {
  const formattedNumber = phoneNumberFormatter(number);
  try {
    const response = await sock.sendMessage(formattedNumber, { text: message });
    console.log(`Message sent to ${formattedNumber}:`, response);
    return response;
  } catch (error) {
    console.error(`Failed to send message to ${formattedNumber}:`, error);
    throw error;
  }
}

// LDAP helper: create client and bind
const getLdapClient = async () => {
  const url = process.env.LDAP_URL || '';
  const bindDN = process.env.BIND_DN || '';
  const bindPW = process.env.BIND_PW || '';
  if (!url || !bindDN || !bindPW) {
    throw new Error('LDAP_URL, BIND_DN, and BIND_PW must be set in environment');
  }

  const client = ldap.createClient({
    url: url.replace('ldap://', 'ldaps://').replace(':389', ':636'),
    tlsOptions: { rejectUnauthorized: false, secureProtocol: 'TLSv1_2_method' },
  });

  return new Promise((resolve, reject) => {
    client.bind(bindDN, bindPW, (err) => {
      if (err) {
        client.unbind();
        return reject(err);
      }
      resolve(client);
    });
  });
};

// Reset password in AD using LDAP
async function resetPassword(upn, newPassword, changePasswordAtNextLogon) {
  try {
    const client = await getLdapClient();
    const baseOu = process.env.BASE_OU || '';
    const userDN = upn.includes(',') ? upn : (baseOu ? `CN=${upn},${baseOu}` : `CN=${upn}`);

    const changes = [
      new ldap.Change({
        operation: 'replace',
        modification: { unicodePwd: Buffer.from(`"${newPassword}"`, 'utf16le') },
      }),
    ];

    if (changePasswordAtNextLogon) {
      changes.push(
        new ldap.Change({
          operation: 'replace',
          modification: { pwdLastSet: '0' },
        })
      );
    }

    for (const change of changes) {
      await new Promise((resolve, reject) => {
        client.modify(userDN, change, (err) => {
          if (err) return reject(err);
          resolve();
        });
      });
    }
    client.unbind();
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

const allowedIPs = process.env.ALLOWED_IPS ? process.env.ALLOWED_IPS.split(',').map(ip => ip.trim()) : ['127.0.0.1', '::1'];
const allowedPhoneNumbers = process.env.ALLOWED_PHONE_NUMBERS ? process.env.ALLOWED_PHONE_NUMBERS.split(',').map(num => num.trim()) : [];

const normalizeIP = (ip) => {
  if (ip.startsWith('::ffff:')) {
    return ip.split('::ffff:')[1];
  }
  return ip;
};

const sendAlertMessage = async (ip, path) => {
  console.log(`Unauthorized access attempt detected from IP: ${ip} to endpoint: ${path}`);
  // Send alert to admin via WhatsApp
  const alertReceiverNumber = '6285712612218@s.whatsapp.net';
  if (sock) {
    try {
      await sock.sendMessage(alertReceiverNumber, { text: `🚨 Unauthorized access attempt from IP: ${ip} to endpoint: ${path}` });
    } catch (err) {
      console.error('Failed to send WhatsApp alert:', err);
    }
  }
};

const checkIP = async (req, res, next) => {
  const requestIP = req.headers['x-forwarded-for'] || req.ip || req.connection.remoteAddress;
  const ips = requestIP.split(',').map(ip => ip.trim());
  const clientIP = normalizeIP(ips[0]);

  console.log('Request IP:', requestIP);
  console.log('Client IP:', clientIP);

  if (allowedIPs.includes(clientIP)) {
    next();
  } else {
    console.log('Forbidden IP:', clientIP);
    await sendAlertMessage(clientIP, req.path);
    res.status(403).json({ message: 'Forbidden' });
  }
};

app.post(
  '/send-message',
  checkIP,
  upload.single('image'),
  [
    body('number')
      .trim()
      .notEmpty()
      .withMessage('Number cannot be empty'),
    // message or image (file, URL, or buffer) must be present
    body('message')
      .trim()
      .custom((v, { req }) => {
        if (!v && !req.file && !req.body.imageUrl && !req.body.imageBuffer) {
          throw new Error('Either message text or image (file, URL, or buffer) must be provided');
        }
        return true;
      }),
    // Validate imageBuffer if provided
    body('imageBuffer')
      .optional()
      .custom((value) => {
        if (value && typeof value !== 'string') {
          throw new Error('imageBuffer must be a base64 encoded string');
        }
        return true;
      }),
  ],
  async (req, res) => {
    // 1) Validate
    const errors = validationResult(req).formatWith(({ msg }) => msg);
    if (!errors.isEmpty()) {
      return res.status(422).json({ status: false, errors: errors.mapped() });
    }

    // 2) Format number and check registration
    const number = phoneNumberFormatter(req.body.number);
    if (!(await checkRegisteredNumber(number))) {
      return res.status(422).json({
        status: false,
        message: 'The number is not registered',
      });
    }

    // 3) Build payload
    let payload;
    if (req.file) {
      // Disk storage: read file from uploads folder
      const fileBuffer = await fs.promises.readFile(req.file.path);
      payload = {
        image: fileBuffer,
        caption: req.body.message || '',
      };
    } else if (req.body.imageBuffer) {
      // Handle base64 encoded image buffer
      try {
        const imageBuffer = Buffer.from(req.body.imageBuffer, 'base64');
        payload = {
          image: imageBuffer,
          caption: req.body.message || '',
        };
      } catch (err) {
        return res.status(422).json({
          status: false,
          message: 'Invalid base64 imageBuffer format',
          error: err.message
        });
      }
    } else if (req.body.imageUrl) {
      payload = {
        image: { url: req.body.imageUrl },
        caption: req.body.message || '',
      };
    } else {
      payload = { text: req.body.message };
    }

    // 4) Send
    try {
      const response = await sock.sendMessage(number, payload);
      return res.status(200).json({ status: true, response });
    } catch (err) {
      console.error('Error sending message:', err);
      return res.status(500).json({ status: false, error: err.toString() });
    }
  }
);

app.post('/send-bulk-message', checkIP, async (req, res) => {
  const { message, numbers, minDelay, maxDelay } = req.body;

  if (!message || !numbers) {
    return res.status(400).json({ status: false, message: 'Message and numbers are required.' });
  }

  if (!minDelay || !maxDelay) {
    return res.status(400).json({ status: false, message: 'Minimum and maximum delay are required.' });
  }

  try {
    console.log('Received numbers array:', numbers);

    for (const number of numbers) {
      console.log('Sending message to:', number);
      await sendMessage(number, message);
      const delayDuration = Math.floor(Math.random() * (maxDelay - minDelay + 1)) + minDelay;
      console.log(`Waiting for ${delayDuration} miliseconds before sending the next message.`);
      await delay(delayDuration);
    }

    res.status(200).json({ status: true, message: 'Messages sent successfully.' });
  } catch (error) {
    console.error('Error sending bulk messages:', error);
    res.status(500).json({ status: false, message: error.message });
  }
});

const extractMessageContent = (msg) => {
    const message = msg.message;
    if (!message) return '';

    if (message.conversation) {
        return message.conversation;
    } else if (message.imageMessage) {
        return message.imageMessage.caption || 'Image';
    } else if (message.videoMessage) {
        return message.videoMessage.caption || 'Video';
    } else if (message.extendedTextMessage) {
        return message.extendedTextMessage.text || '';
    } else if (message.documentMessage) {
        return message.documentMessage.caption || 'Document';
    } else if (message.buttonsResponseMessage) {
        return message.buttonsResponseMessage.selectedButtonId;
    } else if (message.listResponseMessage) {
        return message.listResponseMessage.singleSelectReply.selectedRowId;
    } else if (message.templateButtonReplyMessage) {
        return message.templateButtonReplyMessage.selectedId;
    } else if (message.ephemeralMessage) {
        const ephemeralContent = message.ephemeralMessage.message;
        if (ephemeralContent) {
             return extractMessageContent({ message: ephemeralContent });
        }
    }

    return 'Media/Other';
};

const handleMessage = async (sock, msg, remoteJid, messageContent) => {
    const isGroup = remoteJid.endsWith('@g.us');
    const sender = isGroup ? msg.key.participant : remoteJid;
    let senderNumber = sender;

    if (sender.includes('@lid')) {
        senderNumber = store.contacts[sender]?.id || sender;
        if (senderNumber.includes('@lid')) {
            const lidUser = sender.split('@')[0];
            const mappingFile = path.join('auth_info_baileys', `lid-mapping-${lidUser}_reverse.json`);
            if (existsSync(mappingFile)) {
                try {
                    const mappedUser = JSON.parse(readFileSync(mappingFile, 'utf-8'));
                    senderNumber = mappedUser + '@s.whatsapp.net';
                } catch (e) {}
            }
        }
    }

    const pushName = msg.pushName || 'Unknown';
    if (isGroup) console.log(`Group Message from ${pushName} (${senderNumber}) in Group ${remoteJid}`);
    else console.log(`Private Message from ${pushName} (${senderNumber})`);
    console.log(`Content: ${messageContent}`);

    // N8N Integration
    if (process.env.N8N_WEBHOOK_URL) {
        const payload = {
            message: messageContent,
            from: senderNumber,
            pushName: pushName,
            isGroup: isGroup,
            groupId: isGroup ? remoteJid : null,
            timestamp: new Date().toISOString(),
            messageId: msg.key.id
        };

        try {
            console.log(`Sending to N8N: ${process.env.N8N_WEBHOOK_URL}`);
            
            let data;
            if (process.env.N8N_WEBHOOK_URL.startsWith('https://')) {
                data = await new Promise((resolve, reject) => {
                    const parsedUrl = new URL(process.env.N8N_WEBHOOK_URL);
                    const postData = JSON.stringify(payload);
                    
                    const options = {
                        hostname: parsedUrl.hostname,
                        port: parsedUrl.port || 443,
                        path: parsedUrl.pathname + parsedUrl.search,
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Content-Length': Buffer.byteLength(postData)
                        },
                        rejectUnauthorized: false, // Ignore SSL certificate validation errors
                        timeout: N8N_TIMEOUT
                    };
                    
                    const req = https.request(options, (res) => {
                        let responseData = '';
                        res.on('data', (chunk) => { responseData += chunk; });
                        res.on('end', () => {
                            if (res.statusCode >= 200 && res.statusCode < 300) {
                                try {
                                    resolve(JSON.parse(responseData));
                                } catch {
                                    resolve({});
                                }
                            } else {
                                console.error('N8N Webhook failed:', res.statusCode, res.statusMessage);
                                reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`));
                            }
                        });
                    });
                    
                    req.on('error', (error) => {
                        console.error('N8N HTTPS request error:', error);
                        reject(error);
                    });
                    
                    req.on('timeout', () => {
                        req.destroy();
                        reject(new Error('Request timeout'));
                    });
                    
                    req.write(postData);
                    req.end();
                });
            } else {
                const response = await fetch(process.env.N8N_WEBHOOK_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                
                if (response.ok) {
                    data = await response.json().catch(() => ({}));
                } else {
                    console.error('N8N Webhook failed:', response.status, response.statusText);
                    return;
                }
            }

            let replyText;
            if (Array.isArray(data) && data.length > 0) {
                const firstItem = data[0];
                replyText = firstItem.output || firstItem.message || firstItem.text || firstItem.response || firstItem.reply;
            } else if (typeof data === 'object' && data !== null) {
                replyText = data.output || data.message || data.text || data.response || data.reply;
            } else if (typeof data === 'string') {
                replyText = data;
            }

            console.log('N8N Response:', JSON.stringify(data, null, 2));

            if (replyText) {
                await sock.sendMessage(remoteJid, { text: replyText });
            }
        } catch (error) {
            console.error('Error sending to N8N:', error);
        }
    }
};

const handleCommand = async (sock, msg, remoteJid, messageContent) => {
    if (!messageContent.startsWith('/')) return;

    const [command, ...args] = messageContent.trim().split(/\s+/);

    switch(command.toLowerCase()) {
        case '/hi':
            await sock.sendMessage(remoteJid, { text: 'Hello!' }, { quoted: msg });
            break;
        case '/help':
            await sock.sendMessage(remoteJid, { 
                text: 'Available commands:\n/hi - Say hello\n/help - Show this help message' 
            }, { quoted: msg });
            break;
        case '/resetpassword': {
            const parts = messageContent.split(/ |\u00A0|'/);
            const username = parts[1];
            const newPassword = parts[2];
            if (!username || !newPassword) {
                await sock.sendMessage(remoteJid, { 
                    text: '❌ Usage: /resetpassword <username> <newPassword> [/change]\nExample: /resetpassword john.doe NewPass123 /change' 
                }, { quoted: msg });
                break;
            }
            const changePasswordAtNextLogon = parts.length > 3 && parts[3] === '/change';

            const match = remoteJid.match(/(\d+)@s\.whatsapp\.net/);
            const requester = match ? match[1] : undefined;
            if (!requester || (allowedPhoneNumbers.length && !allowedPhoneNumbers.includes(requester))) {
                await sock.sendMessage(remoteJid, { text: 'Access denied.' }, { quoted: msg });
                break;
            }

            const result = await resetPassword(username, newPassword, changePasswordAtNextLogon);
            if (!result.success) {
                await sock.sendMessage(remoteJid, { text: `Error resetting password for ${username}: ${result.error}` }, { quoted: msg });
            } else {
                await sock.sendMessage(remoteJid, { text: `Password reset for ${username} successful` }, { quoted: msg });
            }
            break;
        }
        default:
            // Optional: Reply to unknown commands or just ignore
            // await sock.sendMessage(remoteJid, { text: 'Unknown command' }, { quoted: msg });
            break;
    }
};

const startSock = async () => {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    sock = makeWASocket({
        auth: {
            creds: state.creds,
            // Support for LIDs and other keys required by Baileys v7+
            keys: makeCacheableSignalKeyStore(state.keys, Pino({ level: "fatal" })),
        },
        printQRInTerminal: true,
        logger: Pino({ level: "fatal" }), // Keep logs clean
        browser: Browsers.macOS('Desktop'),
        // Baileys v7 default behavior usually handles LIDs automatically
    });

    store.bind(sock.ev);

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('QR Code received');
            const url = await qrcode.toDataURL(qr);
            io.emit('qr', url);
            io.emit('message', 'QR Code received, scan please!');
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Connection closed due to ', lastDisconnect?.error, ', reconnecting ', shouldReconnect);
            io.emit('message', 'Disconnected, reconnecting...');
            
            if (shouldReconnect) {
                startSock();
            }
        } else if (connection === 'open') {
            console.log('Opened connection');
            io.emit('ready', 'WhatsApp is ready!');
            io.emit('message', 'WhatsApp is ready!');

            // Send message to specific number on connection
            try {
                const number = '6285712612218@s.whatsapp.net'; // Formatted number
                await sock.sendMessage(number, { text: 'WhatsApp API Connected Successfully!' });
                console.log(`Sent connection message to ${number}`);

                // List all groups
                console.log('Fetching groups...');
                const groups = await sock.groupFetchAllParticipating();
                console.log('Groups list:');
                for (const group of Object.values(groups)) {
                    console.log(`ID: ${group.id} | Name: ${group.subject}`);
                }
            } catch (error) {
                console.error('Error in post-connection tasks:', error);
            }
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        // console.log(JSON.stringify(m, undefined, 2));
        // Minimal echo example or just processing
        if (m.type === 'notify') {
            for (const msg of m.messages) {
                if (!msg.key.fromMe) {
                    const remoteJid = msg.key.remoteJid;
                    
                    // Log message content for context
                    const messageContent = extractMessageContent(msg);

                    if (messageContent.startsWith('/')) {
                        await handleCommand(sock, msg, remoteJid, messageContent);
                    } else {
                        await handleMessage(sock, msg, remoteJid, messageContent);
                    }
                }
            }
        }
    });
};

server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    startSock();
});
