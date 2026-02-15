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
import { findUsersByCommonName, renderFindUserCaption, resetPassword } from '../integrations/ldap.js';
import {
  addTechnicianContact,
  deleteTechnicianContact,
  getTechnicianContactById,
  listTechnicianContacts,
  searchTechnicianContacts,
  updateTechnicianContact,
} from '../integrations/technicianContacts.js';
import type { TechnicianContact, TechnicianContactUpdateField } from '../integrations/technicianContacts.js';

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
    usage: '/getasset <asset_id>',
    description: 'Gets the details of the asset with the given ID.',
    examples: ['/getasset PC', '/getasset notebook', '/getasset monitor'],
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
    description: 'Retrieves BitLocker status for the specified asset ID.',
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

function renderTechnicianLine(c: TechnicianContact): string {
  const email = c.email ?? 'N/A';
  const gender = c.gender ?? 'N/A';
  return `#${c.id} - ${c.name}\nRole: ${c.technician}\nICT Name: ${c.ict_name}\nPhone: ${c.phone}\nEmail: ${email}\nGender: ${gender}`;
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
          await sock.sendMessage(remoteJid, { text: 'No technicians found.' });
          return;
        }

        const lines = contacts.map((c) => `#${c.id} - ${c.name} (${c.technician}) - ${c.phone}`);
        await sock.sendMessage(remoteJid, { text: `*Technicians* (${contacts.length})\n\n${lines.join('\n')}` });
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

        const lines = results.map((c) => `#${c.id} - ${c.name} (${c.technician}) - ${c.phone}`);
        await sock.sendMessage(remoteJid, { text: `*Matches* (${results.length})\n\n${lines.join('\n')}` });
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

        await sock.sendMessage(remoteJid, { text: renderTechnicianLine(contact) });
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

        await sock.sendMessage(remoteJid, { text: `Technician added.\n\n${renderTechnicianLine(created)}` });
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

        await sock.sendMessage(remoteJid, { text: `Technician updated.\n\n${renderTechnicianLine(updated)}` });
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
