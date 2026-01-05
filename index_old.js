import {
  makeWASocket, 
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  Browsers
} from '@whiskeysockets/baileys';


import { bindHistory, loadHistory, saveHistory } from './utils/historyStore.js';
import cors from 'cors';
import { getUserPhotoFromDB, validatePhotoData } from './modules/db.js';
import dotenv from 'dotenv';
import express from 'express';
import { body, validationResult } from 'express-validator';
import qrcode from 'qrcode';
import Pino from 'pino';
import { Boom } from '@hapi/boom';
import randomstring from 'randomstring';
import multer from 'multer';
import https from 'https';
import { decode } from 'html-entities';
import { storeMessage, getMessage, cleanupOldMessages, markMessageAsReacted, findReacterNumber } from './fileStore.js';
import onedrive from './modules/onedrive.js';
import { getAIBrowser } from './modules/perplexity.js';
import {
  initContactMapping,
  processMessageForMapping,
  processReactionForMapping,
  resolvePhoneNumber,
  scanBaileysStore
} from './utils/lidResolver.js';
import { phoneNumberFormatter } from './utils/phoneFormatter.js';

dotenv.config();

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
// //const upload = multer({ dest: 'uploads/' }); // Configure multer to save files to 'uploads/' directory
// //Import module alarm
import schedule from 'node-schedule';
import { initializeSock, handleAlarm, loadAlarms, saveAlarms, modifyAlarmById, listAlarmsByCondition } from './alarm.js';

// // This section is responsible for handling the integration with the ServiceDesk Plus API.
// // It includes functions to manage requests, update templates, and handle incoming webhooks.
import ticketHandler from './modules/ticket_handle.js';
import {
    addTechnician,
    getAllTechnicians,
    getTechnicianById,
    searchTechnicians,
    updateTechnician,
    deleteTechnician,
    formatTechnicianDisplay,
    formatTechniciansDisplay
} from './modules/technician_manager.js';

import {
  get_all_requests,
  view_request,
  updateRequest,
  handleCreateTicket,  // This renames handleCreateTicket to createTicket
  defineServiceCategory,
  ticket_report, // Added ticket_report to the imports
  handleAndAnalyzeAttachments //This function used to analyze PDF attachment on ticket
} from './modules/ticket_handle.js';
console.log("Available functions:", Object.keys(ticketHandler));
console.log("Create ticket function:", createTicket);

import Redis from 'ioredis';

const redis = new Redis({
  host: process.env.REDIS_HOST || '10.60.10.46',   // ← note the comma here
  port: parseInt(process.env.REDIS_PORT, 10) || 6379
});

redis.on('error', err => console.error('Redis error', err));
console.log(`Connecting to Redis at ${redis.options.host}:${redis.options.port}`);


//ChatGPT
import OpenAI from 'openai';
import ldap from 'ldapjs';
const keyopenai = process.env.OPENAI_API_KEY;
const openai = new OpenAI({ apiKey: keyopenai });

//Active Directory Integration
import ActiveDirectory from 'activedirectory2';
//import { MessageType, MessageOptions, Mimetype } from '@whiskeysockets/baileys'
//Zabbix integration
import axios from 'axios';
// const puppeteer = require('puppeteer-extra');
// const StealthPlugin = require('puppeteer-extra-plugin-stealth');
// puppeteer.use(StealthPlugin());

//Router OS
import { RouterOSAPI } from 'node-routeros';

const app = express();
app.use(cors()); 
app.use(express.json()); // Middleware to parse JSON bodies
app.use(express.urlencoded({ extended: true })); // Middleware to parse x-www-form-urlencoded bodies

//Implement Socket IO
import path from 'path';
import { fileURLToPath } from 'url';
import NodeCache from 'node-cache';
import { createServer } from 'http';
import { Server } from 'socket.io';
const server = createServer(app);
const io = new Server(server);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// cache for group metadata to avoid rate limits when sending group messages
const groupCache = new NodeCache({ stdTTL: 3600, checkperiod: 120 });

//Excel file handling
import ExcelJS from 'exceljs';
import fs from 'fs';
import { downloadContentFromMessage, downloadMediaMessage } from '@whiskeysockets/baileys';
import mime from 'mime-types';

//ServiceDesk Plus
const base_url = process.env.SD_BASE_URL;
const headers = {
  authtoken: process.env.SERVICE_DESK_TOKEN,
  'Content-Type': 'application/x-www-form-urlencoded',
};
// Create an HTTPS agent that ignores self-signed certificates
const httpsAgent = new https.Agent({
  rejectUnauthorized: false
});
// Create an HTTPS agent that ignores self-signed certificates
const agent = new https.Agent({
  rejectUnauthorized: false
});
//Load Technician contact
import {
  getContactByName,
  getContactByPhone,
  getContactByEmail, 
  getContactByIctTechnicianName,
  addContact
} from './technicianContacts.js';
import { type } from 'os';
//----------------------------------------------------------------------

// Serve the index.html file
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const allowedIPs = process.env.ALLOWED_IPS ? process.env.ALLOWED_IPS.split(',').map(ip => ip.trim()) : ['127.0.0.1', '::1']; // Load allowed IPs from environment variable

app.set('trust proxy', true); // Trust the first proxy

const normalizeIP = (ip) => {
  if (ip.startsWith('::ffff:')) {
    return ip.split('::ffff:')[1]; // Convert IPv6-mapped IPv4 address to IPv4
  }
  return ip;
};

const sendAlertMessage = async (ip, path) => {
  // Implement your alert mechanism here
  // For example, send an email or a WhatsApp message
  console.log(`Unauthorized access attempt detected from IP: ${ip} to endpoint: ${path}`);
  // Example implementation (replace with actual sending code)
  const message = `Unauthorized access attempt detected from IP: ${ip} to endpoint: ${path}`;
  const alertReceiverNumber = phoneNumberFormatter('085712612218');
  await sock.sendMessage(alertReceiverNumber, { text: message }); // Replace with actual alert sending logic
};
const checkIP = async (req, res, next) => {
  const requestIP = req.headers['x-forwarded-for'] || req.ip || req.connection.remoteAddress;
  const ips = requestIP.split(',').map(ip => ip.trim()); // Split and trim if there are multiple IPs in x-forwarded-for
  const clientIP = normalizeIP(ips[0]); // Normalize the client's IP

  console.log('Request IP:', requestIP);
  console.log('Client IP:', clientIP);

  if (allowedIPs.includes(clientIP)) {
    next(); // Allow the request to proceed
  } else {
    console.log('Forbidden IP:', clientIP);
    await sendAlertMessage(clientIP, req.path); // Send an alert message
    res.status(403).json({ message: 'Forbidden' }); // Deny the request
  }
};


const PORT = process.env.PORT || 8192;

loadHistory();
// Save history to a file every 10 seconds
setInterval(() => {
    saveHistory();
}, 10000);

// Load alarms when the script starts
loadAlarms();

let sock;
let currentStatus = 'Connecting...';
let currentQr = null;
let isAuthenticated = false;

io.on('connection', (socket) => {
  console.log('A user connected');
  
  // Emit the current status and QR code (if available) to the new client
  socket.emit('message', currentStatus);
  if (currentQr && !isAuthenticated) {
    socket.emit('qr', currentQr);
  }

  socket.on('disconnect', () => {
    console.log('A user disconnected');
  });

  socket.on('log', (msg) => {
    console.log('Log: ', msg);
    io.emit('message', msg);
  });
});

const allowedPhoneNumbers = process.env.ALLOWED_PHONE_NUMBERS ? process.env.ALLOWED_PHONE_NUMBERS.split(',').map(num => num.trim()) : []; // Load allowed phone numbers from environment variable

// const restrictedPhoneNumbers = [
//   '6285338861845', //sahrun
//   '6287859142545', //Reza
//   '6281316087498', //Hendra
//   '6285772463669', //Arief
//   // Add more allowed numbers as needed
// ];
const restrictedPhoneNumbers = [
  '6287859142545', //Reza
  '6281316087498', //Hendraedsasasd
  '6285772463669', //Arief
  // Add more allowed numbers as needed
];

// phoneNumberFormatter moved to utils/phoneFormatter.js to avoid circular dependencies

const checkRegisteredNumber = async (number) => {
  if (!sock) {
      console.error('WhatsApp socket is not initialized.');
      return false;
  }
  try {
      const [result] = await sock.onWhatsApp(number);
      return result.exists;
  } catch (error) {
      console.error('Error checking registered number:', error);
      return false;
  }
};

const findGroupByName = async (name) => {
  if (!sock) {
      console.error('WhatsApp socket is not initialized.');
      return null;
  }

  // Try to get groups from cache first to avoid hitting the rate limit
  let groups = groupCache.keys().map(key => groupCache.get(key));

  // If cache is empty, fetch groups from network and update the cache
  if (groups.length === 0) {
      console.log('Fetching all groups from WhatsApp...');
      try {
          groups = Object.values(await sock.groupFetchAllParticipating());
          groups.forEach(g => groupCache.set(g.id, g));
      } catch (error) {
          console.error('Error fetching groups:', error);
          return null;
      }
  }

  if (groups.length === 0) {
      console.log('No groups found.');
      return null;
  }

  const group = groups.find(g => g.subject && g.subject.toLowerCase() === name.toLowerCase());
  if (group) {
      console.log(`Found group: id_group: ${group.id} || Nama Group: ${group.subject}`);
      return group;
  } else {
      console.log(`No group found with name: ${name}`);
      return null;
  }
};

const listGroups = async () => {
    console.log('Fetching all groups...');
    let groups = Object.values(await sock.groupFetchAllParticipating());
    groups.forEach(g => groupCache.set(g.id, g));
    if (groups.length === 0) {
        console.log('No groups found.');
    } else {
        groups.forEach(group => {
            console.log(`id_group: ${group.id} || Nama Group: ${group.subject}`);
        });
    }
};


const mtiConfig = {
  url: process.env.LDAP_URL.replace('ldap://10.60.10.56:389', 'ldaps://10.60.10.56:636'),
  baseDN: process.env.LDAP_BASE_DN,
  username: process.env.LDAP_USERNAME,
  password: process.env.LDAP_PASSWORD,
  tlsOptions: {
    // This disables certificate validation (INSECURE)
    rejectUnauthorized: false,
    secureProtocol: 'TLSv1_2_method'
  },
  // Additional security options for LDAP binding
  bindDN: process.env.LDAP_USERNAME,
  bindCredentials: process.env.LDAP_PASSWORD,
  attributes: {
    user: [
      'dn',
      'distinguishedName',
      'userPrincipalName',
      'sAMAccountName',
      'mail',
      'whenCreated',
      'pwdLastSet',
      'userAccountControl',
      'sn',
      'givenName',
      'cn',
      'displayName',
      'title',
      'department',
      'telephoneNumber',
      'mobile',
      'mobileNumber',
      'streetAddress',
      'city',
      'state',
      'msDS-UserPasswordExpiryTimeComputed',
      'postalCode',
      'gender',
      'employeeID',
    ]
  }
};

  
// Create ActiveDirectory objects for each configuration
const admti = new ActiveDirectory(mtiConfig);

const getLdapClient = async () => {
  const client = ldap.createClient({
    url: process.env.LDAP_URL.replace('ldap://10.60.10.56:389', 'ldaps://10.60.10.56:636'),
    tlsOptions: { 
      rejectUnauthorized: false,
      secureProtocol: 'TLSv1_2_method'
    },
  });
  return new Promise((resolve, reject) => {
    client.bind(process.env.BIND_DN, process.env.BIND_PW, (err) => {
      if (err) {
        client.unbind();
        return reject(err);
      }
      resolve(client);
    });
  });
};

function convertFileTimeToDateString(fileTime) {
    const EPOCH_DIFFERENCE = 11644473600000;
    const timeInMilliseconds = (fileTime / 10000) - EPOCH_DIFFERENCE;
    return new Date(timeInMilliseconds).toLocaleString();
}
  
function isExceptionallyLongDate(dateString) {
    const [datePart, timePart] = dateString.split(', ');
    const year = new Date(datePart).getFullYear();
    const thresholdYear = 2100;
    return year > thresholdYear;
}

//Zabbix configuration
const zabbixConfig = {
    url: process.env.ZABBIX_URL,
    user: process.env.ZABBIX_USER,
    password: process.env.ZABBIX_PASSWORD,
  };

  async function loginToZabbix() {
    try {
      const response = await axios.post(zabbixConfig.url, {
        jsonrpc: '2.0',
        method: 'user.login',
        params: {
          user: zabbixConfig.user,
          password: zabbixConfig.password,
        },
        id: 1,
      });
  
      if (response.data.result) {
        return response.data.result;
      } else {
        console.error('Login Failed. API Response:', response.data);
        throw new Error('Login failed');
      }
    } catch (error) {
      console.error('Login Error:', error.message);
    }
  }

  async function getUPSInfoForHost(authToken, hostName, itemKeys) {
    try {
      const hostResponse = await axios.post(zabbixConfig.url, {
        jsonrpc: '2.0',
        method: 'host.get',
        params: {
          output: ['hostid'],
          filter: {
            host: [hostName],
          },
        },
        auth: authToken,
        id: 3,
      });
  
      if (hostResponse.data.result.length === 0) {
        console.error(`Host '${hostName}' not found.`);
        return;
      }
  
      const hostId = hostResponse.data.result[0].hostid;
  
      const upsInfo = {};
  
      for (const itemKey of itemKeys) {
        const itemResponse = await axios.post(zabbixConfig.url, {
          jsonrpc: '2.0',
          method: 'item.get',
          params: {
            output: ['hostid', 'name', 'lastvalue'],
            hostids: [hostId],
            search: {
              key_: itemKey,
            },
          },
          auth: authToken,
          id: 4,
        });
  
        if (itemResponse.data.result.length > 0) {
          const item = itemResponse.data.result[0];
          const itemName = item.name.replace(`APC Smart-UPS SRT 5000: `, ''); // Remove the prefix
          upsInfo[itemName] = item.lastvalue;
        }
      }
  
      return upsInfo;
    } catch (error) {
      console.error('UPS Information Error:', error.message);
    }
  }
  
function addUnits(key, value) {
    const unitMap = {
      'voltage': 'V',
      'current': 'A',
      'capacity': '%',
      'frequency': 'Hz',
    };
  
    const unit = unitMap[Object.keys(unitMap).find(keyword => key.toLowerCase().includes(keyword))] || '';
    return `${value} ${unit}`;
}
  
function roundToDecimal(value) {
    if (typeof value === 'string') {
      const floatValue = parseFloat(value);
      if (!isNaN(floatValue)) {
        return floatValue.toFixed(1);
      }
    }
    return value;
}
  
function formatTime(seconds) {
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    return `${hrs}h ${mins}m ${secs}s`;
}
  

const hostnameMapping = {
    'mkt': 'UPS-Makarti',
    'pyr': 'UPS-Pyrite',
    // Add more mappings as needed
};

//Snipe-IT configuration
const snipeItConfig = {
    url: process.env.SNIPEIT_URL,
    token: process.env.SNIPEIT_TOKEN,
  };

const categoryMapping = {
  mouse: 'Mouse',
  switch: 'Switch',
  tablet: 'Tablet',
  pc: 'PC Desktop',
  ht: 'HT',
  phone: 'Mobile Phone [Non Assets]',
  monitor: 'Monitor',
  sim: 'SIM CARD',
  notebook: 'Notebook',
  license: 'Misc Software',
  software: 'Software License',
  antivirus: 'Antivirus License',
  office: 'Office License',
  windows: 'Windows License',
  adobe: 'Adobe License',
  cad: 'CAD License',
  database: 'Database License',
  security: 'Security Software License'
};

//Get all assets filtered by fields, filters, summary, summaryField, and includeDetails
async function getAssets({ fields = [], filters = {}, summary = false, summaryField = '', includeDetails = false } = {}) {
  try {
      // Initial parameters for fetching a large set of data
      const limit = '1000'; // Fetch a large number of assets
      const offset = '0';
      const sort = 'created_at';
      const order = 'desc';

      console.log(`Filters: ${JSON.stringify(filters)}`);
      console.log(`Fields: ${fields.length > 0 ? fields.join(', ') : 'empty'}`);
      console.log(`Summary: ${summary}, SummaryField: ${summaryField}, IncludeDetails: ${includeDetails}`);

      // Construct the initial query string to fetch the data
      const queryString = new URLSearchParams({
          limit,
          offset,
          sort,
          order
      }).toString();

      const response = await axios.get(`${snipeItConfig.url}/hardware?${queryString}`, {
          headers: {
              Authorization: `Bearer ${snipeItConfig.token}`,
          },
      });

      if (response.data && response.data.total > 0) {
          let assets = response.data.rows;

          // Apply filtering only if filters are provided
          if (Object.keys(filters).length > 0) {
              assets = assets.filter(asset => {
                  return Object.entries(filters).every(([key, value]) => {
                      const fieldMapping = {
                          'name': asset.name,
                          'serialnumber': asset.serial,
                          'model': asset.model?.name,
                          'status': asset.status_label?.name,
                          'category': asset.category?.name,
                          'assignedto': asset.assigned_to?.name,
                          'username': asset.assigned_to?.username,
                          'email': asset.assigned_to?.email
                      };
                      return fieldMapping[key.toLowerCase()]?.toLowerCase().includes(value.toLowerCase());
                  });
              });
          }

          // Summarize the results based on the summaryField
          if (summary) {
              const totalAssets = assets.length;
              let summaryOutput = `Total assets: ${totalAssets}\n`;

              if (summaryField) {
                  const grouped = assets.reduce((acc, asset) => {
                      const key = asset[summaryField]?.name || 'Unknown';
                      acc[key] = (acc[key] || 0) + 1;
                      return acc;
                  }, {});

                  for (const [key, count] of Object.entries(grouped)) {
                      summaryOutput += `Total ${key} assets: ${count}\n`;
                  }
              }

              if (!includeDetails) {
                  return summaryOutput;
              }

              // If includeDetails is true, add detailed information
              const detailedAssets = assets.map(asset => {
                  const fieldMapping = {
                      'name': `Name: ${asset.name || 'N/A'}`,
                      'serialnumber': `Serial Number: ${asset.serial || 'N/A'}`,
                      'model': `Model: ${asset.model?.name || 'N/A'}`,
                      'status': `Status: ${asset.status_label?.name || 'N/A'}`,
                      'category': `Category: ${asset.category?.name || 'N/A'}`,
                      'assignedto': asset.status_label?.name === 'Deployed' && asset.assigned_to
                          ? `Assigned To: ${asset.assigned_to.name || 'N/A'}, Username: ${asset.assigned_to.username || 'N/A'}, Email: ${asset.assigned_to.email || 'N/A'}`
                          : 'Not Assigned'
                  };

                  return fields.length > 0
                      ? fields.map(field => fieldMapping[field.toLowerCase()]).filter(Boolean).join(', ')
                      : Object.values(fieldMapping).filter(Boolean).join(', ');
              }).join('\n');

              return summaryOutput + '\n' + detailedAssets;
          }

          // If not summarizing, return the detailed assets
          const filteredAssets = assets.map(asset => {
              const fieldMapping = {
                  'name': `Name: ${asset.name || 'N/A'}`,
                  'serialnumber': `Serial Number: ${asset.serial || 'N/A'}`,
                  'model': `Model: ${asset.model?.name || 'N/A'}`,
                  'status': `Status: ${asset.status_label?.name || 'N/A'}`,
                  'category': `Category: ${asset.category?.name || 'N/A'}`,
                  'assignedto': asset.status_label?.name === 'Deployed' && asset.assigned_to
                      ? `Assigned To: ${asset.assigned_to.name || 'N/A'}, Username: ${asset.assigned_to.username || 'N/A'}, Email: ${asset.assigned_to.email || 'N/A'}`
                      : 'Not Assigned'
              };

              return fields.length > 0
                  ? fields.map(field => fieldMapping[field.toLowerCase()]).filter(Boolean).join(', ')
                  : Object.values(fieldMapping).filter(Boolean).join(', ');
          });

          return filteredAssets.join('\n');
      } else {
          return `No assets found for the given criteria.`;
      }
  } catch (error) {
      console.error("Error fetching asset data:", error.message);
      return "Could not fetch the asset data. Please try again later.";
  }
}



// async function getAssetsByName() {
//   const filters = { assignedto: 'widji' };
//   const fields = ['name', 'serialnumber', 'model', 'status', 'assignedto'];

//   const assets = await getAssets({ filters, fields });
//   console.log(assets);
// }

// getAssetsByName();




async function getAssetByAttribute({ assetName, fields = [] }) {
  try {
      // Ensure assetName is a string
      assetName = String(assetName);
      console.log(`Asset name: ${assetName}`);
      console.log(`Fields: ${fields}`);

      const response = await axios.get(`${snipeItConfig.url}/hardware?search=${encodeURIComponent(assetName)}&limit=50&offset=0&sort=created_at&order=desc&deleted=false`, {
          headers: {
              Authorization: `Bearer ${snipeItConfig.token}`,
          },
      });

      if (response.data && response.data.total > 0) {
          console.log('Assets retrieved:', response.data.rows); // Display the result
          
          // Create an array to hold the requested fields for each asset
          const assets = response.data.rows;

          // If no fields are specified, return the entire asset objects as sentences
          if (fields.length === 0) {
              return assets.map(asset => 
                  `Asset Tag: ${asset.asset_tag || 'N/A'}, Name: ${asset.name || 'N/A'}, Serial Number: ${asset.serial || 'N/A'}, Model: ${asset.model?.name || 'N/A'}, Status: ${asset.status_label?.name || 'N/A'}, Category: ${asset.category?.name || 'N/A'}, Assigned To: ${asset.assigned_to ? asset.assigned_to.name : 'N/A'}`
              ).join('\n');
          }

          // Check which fields to include based on the provided fields array
          const filteredAssets = assets.map(asset => {
              const filteredAsset = [];
              if (fields.includes('Name')) {
                  filteredAsset.push(`Name: ${asset.name || 'N/A'}`);
              }
              if (fields.includes('SerialNumber')) {
                  filteredAsset.push(`Serial Number: ${asset.serial || 'N/A'}`);
              }
              if (fields.includes('Model')) {
                  filteredAsset.push(`Model: ${asset.model?.name || 'N/A'}`);
              }
              if (fields.includes('Status')) {
                  filteredAsset.push(`Status: ${asset.status_label?.name || 'N/A'}`);
              }
              if (fields.includes('Category')) {
                  filteredAsset.push(`Category: ${asset.category?.name || 'N/A'}`);
              }
              if (fields.includes('AssignedTo') && asset.status_label?.name === 'Deployed') {
                  filteredAsset.push(`Assigned To: ${asset.assigned_to?.name || 'N/A'}, Username: ${asset.assigned_to?.username || 'N/A'}, Email: ${asset.assigned_to?.email || 'N/A'}`);
              }
              return filteredAsset.join(', ');
          });

          return filteredAssets.join('\n'); // Return the structured asset information as sentences
      } else {
          return `No assets found with the name ${assetName}.`;
      }
  } catch (error) {
      console.error("Error fetching asset data:", error);
      return "Could not fetch the asset data. Please try again later.";
  }
}

async function getAssetByTag({ assetTag, fields = [] }) {
  try {
      // Ensure assetTag is a string
      assetTag = String(assetTag);
      console.log(`Asset tag: ${assetTag}`);
      console.log(`Fields: ${fields}`);

      const response = await axios.get(`${snipeItConfig.url}/hardware/bytag/${assetTag}?deleted=false`, {
          headers: {
              Authorization: `Bearer ${snipeItConfig.token}`,
          },
      });

      if (response.data && response.data.status !== 'error') {
          console.log('Asset retrieved:', response.data); // Display the result
          
          // Create an object to hold the requested fields
          const asset = response.data; // Store all asset data directly

          // If no fields are specified, return the entire asset object as a sentence
          if (fields.length === 0) {
              return `Asset Tag: ${assetTag}, Name: ${asset.name || 'N/A'}, Serial Number: ${asset.serial || 'N/A'}, Model: ${asset.model?.name || 'N/A'}, Status: ${asset.status_label?.name || 'N/A'}, Category: ${asset.category?.name || 'N/A'}, Assigned To: ${asset.assigned_to ? asset.assigned_to.name : 'N/A'}`;
          }

          // Check which fields to include based on the provided fields array
          const filteredAsset = [];
          if (fields.includes('Name')) {
              filteredAsset.push(`Name: ${asset.name || 'N/A'}`);
          }
          if (fields.includes('SerialNumber')) {
              filteredAsset.push(`Serial Number: ${asset.serial || 'N/A'}`);
          }
          if (fields.includes('Model')) {
              filteredAsset.push(`Model: ${asset.model?.name || 'N/A'}`);
          }
          if (fields.includes('Status')) {
              filteredAsset.push(`Status: ${asset.status_label?.name || 'N/A'}`);
          }
          if (fields.includes('Category')) {
              filteredAsset.push(`Category: ${asset.category?.name || 'N/A'}`);
          }
          if (fields.includes('AssignedTo') && asset.status_label?.name === 'Deployed') {
              filteredAsset.push(`Assigned To: ${asset.assigned_to?.name || 'N/A'}, Username: ${asset.assigned_to?.username || 'N/A'}, Email: ${asset.assigned_to?.email || 'N/A'}`);
          }

          return filteredAsset.join(', '); // Return the structured asset information as a sentence
      } else {
          return `Asset with tag ${assetTag} does not exist.`;
      }
  } catch (error) {
      console.error('Error retrieving asset:', error.message);
      return `Error retrieving asset: ${error.message}`;
  }
}

// // Example of calling the function directly
// getAssetByTag({ assetTag: "MTI-NB-177", fields: ["Name", "AssignedTo"] }).then(printResult => {
//   console.log(`--------This is the value ${printResult}`);
// }).catch(error => {
//   console.error(`Error: ${error.message}`);
// });

async function getAllCategories() {
    try {
      const response = await axios.get(`${snipeItConfig.url}/categories`, {
        headers: {
          Authorization: `Bearer ${snipeItConfig.token}`,
        },
      });
  
      if (response.data.rows) {
        console.log('Categories retrieved:', response.data.rows); // Display the result
        return response.data.rows;
      } else {
        throw new Error('No categories found');
      }
    } catch (error) {
      console.error('Error retrieving categories:', error.message);
      throw error;
    }
  }

  async function getCategoryIdByName(categoryName) {
    try {
      const categories = await getAllCategories();
      const category = categories.find(cat => cat.name.toLowerCase() === categoryName.toLowerCase());
      return category ? category.id : null;
    } catch (error) {
      console.error(`Error retrieving category ID for ${categoryName}:`, error.message);
      throw error;
    }
  }
  
  async function getAssetCountByStatusAndCore(assets, statusName, coreType) {
    return assets.filter(asset => 
        asset.status_label.name.toLowerCase() === statusName.toLowerCase() && 
        asset.custom_fields['Core Type'] && 
        asset.custom_fields['Core Type'].value.toLowerCase() === coreType.toLowerCase()
    ).length;
  }
  async function getAssetsByCategoryId(categoryId, categoryName) {
    try {
      const response = await axios.get(`${snipeItConfig.url}/hardware`, {
        headers: { 'Authorization': `Bearer ${snipeItConfig.token}` },
        params: { category_id: categoryId }
      });
      const assets = response.data.rows;
      const totalAssets = assets.length;
      console.log(response);

      if (categoryName.toLowerCase() === 'notebook') {
        const totalDeployed = assets.filter(asset => asset.status_label.name.toLowerCase() === 'deployed').length;
        const deployedI5 = await getAssetCountByStatusAndCore(assets, 'deployed', 'i5');
        const deployedI7 = await getAssetCountByStatusAndCore(assets, 'deployed', 'i7');
        const deployedUltra5 = await getAssetCountByStatusAndCore(assets, 'deployed', 'Ultra 5');
        const deployedUltra7 = await getAssetCountByStatusAndCore(assets, 'deployed', 'Ultra 7');

        const totalReadyToDeploy = assets.filter(asset => asset.status_label.name.toLowerCase() === 'ready to deploy').length;
        const readyToDeployI5 = await getAssetCountByStatusAndCore(assets, 'ready to deploy', 'i5');
        const readyToDeployI7 = await getAssetCountByStatusAndCore(assets, 'ready to deploy', 'i7');
        const readyToDeployUltra5 = await getAssetCountByStatusAndCore(assets, 'ready to deploy', 'Ultra 5');
        const readyToDeployUltra7 = await getAssetCountByStatusAndCore(assets, 'ready to deploy', 'Ultra 7');

        const totalArchived = assets.filter(asset => asset.status_label.name.toLowerCase() === 'archived').length;
        const totalPending = assets.filter(asset => asset.status_label.name.toLowerCase() === 'pending').length;

        return {
          totalAssets,
          totalDeployed,
          deployedI5,
          deployedI7,
          deployedUltra5,
          deployedUltra7,
          totalReadyToDeploy,
          readyToDeployI5,
          readyToDeployI7,
          readyToDeployUltra5,
          readyToDeployUltra7,
          totalArchived,
          totalPending
        };
      } else {
        const totalDeployed = assets.filter(asset => asset.status_label.name.toLowerCase() === 'deployed').length;
        const totalReadyToDeploy = assets.filter(asset => asset.status_label.name.toLowerCase() === 'ready to deploy').length;
        const totalArchived = assets.filter(asset => asset.status_label.name.toLowerCase() === 'archived').length;
        const totalPending = assets.filter(asset => asset.status_label.name.toLowerCase() === 'pending').length;

        return {
          totalAssets,
          totalDeployed,
          totalReadyToDeploy,
          totalArchived,
          totalPending
        };
      }
    } catch (error) {
      console.error('Error fetching assets:', error);
      throw error;
    }
  }

  // Function to handle the /getasset command or direct calls
  async function handleGetAsset(...args) {
    let sock = null;
    let from = null;
    let input;

    // Check the number of arguments and assign them appropriately
    if (args.length === 1) {
        input = args[0];  // Direct call with category name or object
    } else if (args.length === 3) {
        sock = args[0];
        from = args[1];
        input = args[2];
    } else {
        throw new Error("Invalid number of arguments");
    }

    let categoryName;

    // Determine if input is an object with a category field
    if (typeof input === 'object' && input !== null && 'category' in input) {
        categoryName = input.category;
    } else if (typeof input === 'string' && input.startsWith('/getasset')) {
        // If input is a command string
        const commandParts = input.split(/ |\u00A0|'/);
        categoryName = commandParts[1];
    } else {
        categoryName = input;
    }

    // Debugging output
    console.log("categoryName:", categoryName, "Type:", typeof categoryName);

    let response;

    if (!categoryName) {
        // If no category name is provided, show total assets for each category
        try {
            const categories = await getAllCategories();
            response = 'Total assets in each category:\n';

            for (const category of categories) {
                const { totalAssets } = await getAssetsByCategoryId(category.id, category.name);
                response += `${category.name}: ${totalAssets}\n`;
            }
        } catch (error) {
            console.error('Error getting all categories:', error);
            response = `Error getting categories: Please check the logs on the server.`;
        }
    } else if (typeof categoryName === 'string') {
        const categoryMappedName = categoryMapping[categoryName.toLowerCase()];

        if (!categoryMappedName) {
            response = `Unknown asset type: "${categoryName}". Please use a valid asset type.`;
        } else {
            try {
                const categoryId = await getCategoryIdByName(categoryMappedName);
                if (!categoryId) {
                    response = `Category "${categoryMappedName}" not found.`;
                } else {
                    const assetsData = await getAssetsByCategoryId(categoryId, categoryMappedName);
                    console.log(assetsData);
                    if (categoryMappedName.toLowerCase() === 'notebook') {
                      response = `Total assets in category "${categoryMappedName}": ${assetsData.totalAssets}\n`
                        + `Total deployed devices: ${assetsData.totalDeployed} (i5: ${assetsData.deployedI5}, i7: ${assetsData.deployedI7}, Ultra 5: ${assetsData.deployedUltra5}, Ultra 7: ${assetsData.deployedUltra7})\n`
                        + `Total ready to deploy devices: ${assetsData.totalReadyToDeploy} (i5: ${assetsData.readyToDeployI5}, i7: ${assetsData.readyToDeployI7}, Ultra 5: ${assetsData.readyToDeployUltra5}, Ultra 7: ${assetsData.readyToDeployUltra7})\n`
                        + `Total archived devices: ${assetsData.totalArchived}\n`
                        + `Total pending devices: ${assetsData.totalPending}`;
                    } else {
                      response = `Total assets in category "${categoryMappedName}": ${assetsData.totalAssets}\n`
                        + `Total deployed devices: ${assetsData.totalDeployed}\n`
                        + `Total ready to deploy devices: ${assetsData.totalReadyToDeploy}\n`
                        + `Total archived devices: ${assetsData.totalArchived}\n`
                        + `Total pending devices: ${assetsData.totalPending}`;
                    }
                }
            } catch (error) {
                console.error(`Error getting assets for category ${categoryMappedName}:`, error);
                response = `Error getting assets: Please check the logs on the server.`;
            }
        }
    } else {
        response = `Invalid category name provided.`;
    }

    // Send message if sock and from are provided
    if (sock && from) {
        await sock.sendMessage(from, { text: response });
    }

    // Return the response
    return response;
}

// async function getWarrantyAndLaptopInfo(serviceTag) {
//   const url = `https://www.dell.com/support/home/en-us/product-support/servicetag/${serviceTag}/overview`;

//   // Launch a new browser instance with puppeteer-extra and stealth plugin
//   const browser = await puppeteer.launch({ headless: false, defaultViewport: null });
//   const page = await browser.newPage();

//   try {
//       // Navigate to the page
//       await page.goto(url, { waitUntil: 'networkidle2' });

//       // Wait for the validation timer to appear and interact with the page
//       await page.waitForSelector('.validation-timer', { timeout: 10000 });
//       await page.click('body'); // Click on the body to simulate user interaction
//       await page.keyboard.press('Enter');
//       await page.mouse.move(100, 100);
//       await page.mouse.click(100, 100);

//       // Wait for the timer to complete
//       await page.waitForTimeout(30000);

//       // Reload the page after the timer completes
//       await page.reload({ waitUntil: ["networkidle0", "domcontentloaded"] });

//       // Extract warranty information
//       const [warrantyElement] = await page.$x('//*[@id="ps-inlineWarranty"]/div[1]/div/p');
//       const warrantyInfo = warrantyElement ? await page.evaluate(el => el.textContent.trim(), warrantyElement) : null;

//       if (warrantyInfo) {
//           console.log("Warranty Information:");
//           console.log(warrantyInfo);

//           const expiryMatch = warrantyInfo.match(/Expires\s+\d{2}\s+[A-Z]{3}\s+\d{4}/);
//           if (expiryMatch) {
//               console.log("Formatted Warranty Expiry:");
//               console.log(expiryMatch[0]);
//           } else {
//               console.log("Warranty expiry date not found.");
//           }
//       } else {
//           console.log("Warranty information not found.");
//       }

//       // Extract laptop type
//       const [laptopTypeElement] = await page.$x('//*[@id="site-wrapper"]/div/div[3]/div[1]/div[2]/div[1]/div[2]/div/div/div/div[2]/h1');
//       const laptopType = laptopTypeElement ? await page.evaluate(el => el.textContent.trim(), laptopTypeElement) : null;

//       if (laptopType) {
//           console.log("Laptop Type:");
//           console.log(laptopType);
//       } else {
//           console.log("Laptop type information not found.");
//       }

//       // Extract shipping date
//       const [shippingDateElement] = await page.$x('//*[@id="shippingDateLabel"]/div');
//       const shippingDate = shippingDateElement ? await page.evaluate(el => el.textContent.trim(), shippingDateElement) : null;

//       if (shippingDate) {
//           console.log("Shipping Date:");
//           console.log(shippingDate);
//       } else {
//           console.log("Shipping date information not found.");
//       }
//   } catch (error) {
//       console.error(`Failed to retrieve the page. Error: ${error.message}`);
//   } finally {
//       // Close the browser
//       await browser.close();
//   }
// }

// Replace with your service tag
// const serviceTag = '8052FK3';
// getWarrantyAndLaptopInfo(serviceTag);
// Function to perform the headless test
async function performHeadlessTest(url) {
  // Configure the stealth plugin
  puppeteer.use(StealthPlugin());

  // Set up the browser and launch it
  const browser = await puppeteer.launch({ headless: false });

  try {
      // Open a new blank page
      const page = await browser.newPage();

      // Navigate the page to the target page
      await page.goto(url, { waitUntil: 'networkidle2' });

      // Extract the message of the test result
      const resultElement = await page.$("#res");
      const message = await resultElement.evaluate(e => e.textContent);

      // Print the resulting message
      console.log(`The result of the test is "%s"`, message);
  } catch (error) {
      console.error("An error occurred:", error.message);
  } finally {
      // Close the current browser session
      await browser.close();
  }
}

// Example usage of the function
//performHeadlessTest("https://map.google.com");

// ===== SNIPE-IT LICENSE MANAGEMENT FUNCTIONS =====

/**
 * Get all licenses from Snipe-IT
 * @param {Object} options - Query options
 * @param {Array} options.fields - Fields to include in response
 * @param {Object} options.filters - Filters to apply
 * @param {number} options.limit - Number of results to return
 * @param {number} options.offset - Offset for pagination
 * @returns {Promise<Object>} License data from Snipe-IT
 */
async function getLicenses({ fields = [], filters = {}, limit = 50, offset = 0 } = {}) {
    try {
        // Build query parameters
        const params = new URLSearchParams();
        params.append('limit', limit.toString());
        params.append('offset', offset.toString());
        params.append('sort', 'created_at');
        params.append('order', 'desc');
        
        // Add filters
        Object.entries(filters).forEach(([key, value]) => {
            if (value !== undefined && value !== null) {
                params.append(key, value.toString());
            }
        });
        
        const queryString = params.toString();
        console.log(`Fetching licenses with query: ${queryString}`);
        
        const response = await axios.get(`${snipeItConfig.url}/licenses?${queryString}`, {
            headers: {
                'Authorization': `Bearer ${snipeItConfig.token}`,
                'Accept': 'application/json',
                'Content-Type': 'application/json'
            },
            httpsAgent: agent
        });
        
        return {
            success: true,
            total: response.data.total || 0,
            licenses: response.data.rows || [],
            pagination: {
                limit,
                offset,
                total: response.data.total || 0
            }
        };
    } catch (error) {
        console.error('Error fetching licenses:', error.message);
        if (error.response) {
            console.error('Response data:', error.response.data);
        }
        return {
            success: false,
            error: error.message,
            licenses: [],
            total: 0
        };
    }
}

/**
 * Get a specific license by name or ID
 * @param {string} identifier - License name or ID
 * @returns {Promise<Object>} License details
 */
async function getLicenseByName(identifier) {
    try {
        // First try to get by ID if identifier is numeric
        if (/^\d+$/.test(identifier)) {
            const response = await axios.get(`${snipeItConfig.url}/licenses/${identifier}`, {
                headers: {
                    'Authorization': `Bearer ${snipeItConfig.token}`,
                    'Accept': 'application/json'
                },
                httpsAgent: agent
            });
            
            if (response.data) {
                return {
                    success: true,
                    license: response.data
                };
            }
        }
        
        // Search by name
        const response = await axios.get(`${snipeItConfig.url}/licenses?search=${encodeURIComponent(identifier)}&limit=50`, {
            headers: {
                'Authorization': `Bearer ${snipeItConfig.token}`,
                'Accept': 'application/json'
            },
            httpsAgent: agent
        });
        
        const licenses = response.data.rows || [];
        
        // Find exact match first
        let license = licenses.find(l => l.name && l.name.toLowerCase() === identifier.toLowerCase());
        
        // If no exact match, find partial match
        if (!license && licenses.length > 0) {
            license = licenses.find(l => l.name && l.name.toLowerCase().includes(identifier.toLowerCase()));
        }
        
        if (license) {
            return {
                success: true,
                license: license
            };
        } else {
            return {
                success: false,
                error: `License '${identifier}' not found`,
                suggestions: licenses.slice(0, 5).map(l => l.name).filter(Boolean)
            };
        }
    } catch (error) {
        console.error('Error fetching license by name:', error.message);
        return {
            success: false,
            error: error.message
        };
    }
}

/**
 * Get licenses that are expiring within a specified number of days
 * @param {number} days - Number of days to check for expiration (default: 30)
 * @returns {Promise<Object>} Expiring licenses data
 */
async function getExpiringLicenses(days = 30) {
    try {
        // Get all licenses
        const allLicensesResult = await getLicenses({ limit: 500 });
        
        if (!allLicensesResult.success) {
            return allLicensesResult;
        }
        
        const currentDate = new Date();
        const futureDate = new Date();
        futureDate.setDate(currentDate.getDate() + days);
        
        const expiringLicenses = allLicensesResult.licenses.filter(license => {
            if (!license.expiration_date || !license.expiration_date.date) {
                return false;
            }
            
            const expirationDate = new Date(license.expiration_date.date);
            return expirationDate >= currentDate && expirationDate <= futureDate;
        });
        
        // Sort by expiration date (earliest first)
        expiringLicenses.sort((a, b) => {
            const dateA = new Date(a.expiration_date.date);
            const dateB = new Date(b.expiration_date.date);
            return dateA - dateB;
        });
        
        return {
            success: true,
            total: expiringLicenses.length,
            licenses: expiringLicenses,
            daysChecked: days,
            checkDate: currentDate.toISOString()
        };
    } catch (error) {
        console.error('Error fetching expiring licenses:', error.message);
        return {
            success: false,
            error: error.message,
            licenses: [],
            total: 0
        };
    }
}

/**
 * Get license utilization report
 * @returns {Promise<Object>} License utilization data
 */
async function getLicenseUtilization() {
    try {
        // Get all licenses
        const allLicensesResult = await getLicenses({ limit: 500 });
        
        if (!allLicensesResult.success) {
            return allLicensesResult;
        }
        
        const licenses = allLicensesResult.licenses;
        const utilizationData = {
            totalLicenses: licenses.length,
            categories: {},
            utilization: {
                fullyUtilized: 0,
                partiallyUtilized: 0,
                underUtilized: 0,
                notUtilized: 0
            },
            expiration: {
                expired: 0,
                expiringSoon: 0, // within 30 days
                valid: 0,
                noExpiration: 0
            },
            details: []
        };
        
        const currentDate = new Date();
        const thirtyDaysFromNow = new Date();
        thirtyDaysFromNow.setDate(currentDate.getDate() + 30);
        
        licenses.forEach(license => {
            const seats = license.seats || 0;
            const availableSeats = license.free_seats_count || 0;
            const usedSeats = seats - availableSeats;
            
            // Calculate utilization percentage
            const utilizationPercent = seats > 0 ? (usedSeats / seats) * 100 : 0;
            
            // Categorize utilization
            if (utilizationPercent >= 100) {
                utilizationData.utilization.fullyUtilized++;
            } else if (utilizationPercent >= 50) {
                utilizationData.utilization.partiallyUtilized++;
            } else if (utilizationPercent > 0) {
                utilizationData.utilization.underUtilized++;
            } else {
                utilizationData.utilization.notUtilized++;
            }
            
            // Check expiration status
            if (license.expiration_date && license.expiration_date.date) {
                const expirationDate = new Date(license.expiration_date.date);
                if (expirationDate < currentDate) {
                    utilizationData.expiration.expired++;
                } else if (expirationDate <= thirtyDaysFromNow) {
                    utilizationData.expiration.expiringSoon++;
                } else {
                    utilizationData.expiration.valid++;
                }
            } else {
                utilizationData.expiration.noExpiration++;
            }
            
            // Track by category
            const categoryName = license.category ? license.category.name : 'Uncategorized';
            if (!utilizationData.categories[categoryName]) {
                utilizationData.categories[categoryName] = {
                    count: 0,
                    totalSeats: 0,
                    usedSeats: 0
                };
            }
            
            utilizationData.categories[categoryName].count++;
            utilizationData.categories[categoryName].totalSeats += seats;
            utilizationData.categories[categoryName].usedSeats += usedSeats;
            
            // Add to details
            utilizationData.details.push({
                id: license.id,
                name: license.name,
                category: categoryName,
                seats: seats,
                usedSeats: usedSeats,
                availableSeats: availableSeats,
                utilizationPercent: Math.round(utilizationPercent),
                expirationDate: license.expiration_date ? license.expiration_date.formatted : null,
                manufacturer: license.manufacturer ? license.manufacturer.name : null
            });
        });
        
        return {
            success: true,
            data: utilizationData,
            generatedAt: currentDate.toISOString()
        };
    } catch (error) {
        console.error('Error generating license utilization report:', error.message);
        return {
            success: false,
            error: error.message
        };
    }
}

// ===== END LICENSE MANAGEMENT FUNCTIONS =====

//Mikrotik Integration
const connectRouterOS = async () => {
    const conn = new RouterOSAPI({
      host: process.env.MIKROTIK_HOST,
      user: process.env.MIKROTIK_USER,
      password: process.env.MIKROTIK_PASSWORD,
      // allow timeout to be configured to avoid premature errors
      timeout: parseInt(process.env.MIKROTIK_TIMEOUT, 10) || 20000,
    });
  
    try {
      await conn.connect();
      return conn;
    } catch (error) {
      console.error('Error connecting to RouterOS:', error.message);
      if (error.code) {
        console.error(`Error Code: ${error.code}`);
      }
      if (error.stack) {
        console.error(`Stack Trace: ${error.stack}`);
      }
      throw new Error('Failed to connect to RouterOS. Please check your connection settings and try again.');
    }
};

const poolMapping = {
    '/staff': 'VISITOR-STAFF_VLAN_64',
    '/nonstaff': 'VISITOR-NON_STAFF_VLAN_64_28',
    '/contractor': 'CONTRACTOR_VLAN_67',
    '/management': 'VISITOR-MANAGEMENT_VLAN_64',
    '/employeefull': 'EMPLOYEE - FULL_VLAN_63',
    '/employeelimited': 'EMPLOYEE - LIMITED_VLAN_63',
    // Add more mappings as needed
  };
  
const dhcpServerMapping = {
    '/staff': 'DHCP_VISITOR_VLAN64',
    '/nonstaff': 'DHCP_VISITOR_VLAN64',
    '/contractor': 'DHCP_CONTRACTOR_VLAN67',
    '/management': 'DHCP_VISITOR_VLAN64',
    '/employeefull': 'DHCP_EMPLOYEE_VLAN63',
    '/employeelimited': 'DHCP_EMPLOYEE_VLAN63',
    // Add more mappings as needed
};

// const addWifiUser = async (conn, poolName, macAddress, comment, daysUntilExpiration, isTestMode) => {
//   const addressPool = poolMapping[poolName];
//   const dhcpServer = dhcpServerMapping[poolName] || 'Unknown';

//   if (!addressPool) {
//     throw new Error('Invalid address pool specified. Use /staff, /nonstaff, or /contractor.');
//   }

//   let expirationTimestamp = null;
//   let durationMessage = '';
//   if (daysUntilExpiration) {
//     const expirationDate = new Date();
//     if (isTestMode) {
//       // Set expiration time to minutes instead of days
//       expirationDate.setMinutes(expirationDate.getMinutes() + parseInt(daysUntilExpiration));
//       durationMessage = ` with an expiration of ${daysUntilExpiration} minutes (test mode)`;
//     } else {
//       // Set expiration time to days
//       expirationDate.setDate(expirationDate.getDate() + parseInt(daysUntilExpiration));
//       durationMessage = ` with an expiration of ${daysUntilExpiration} days`;
//     }
//     expirationTimestamp = expirationDate.getTime();
//   }

//   try {
//     const data = await conn.write('/ip/dhcp-server/lease/add', [
//       `=address=${addressPool}`,
//       `=mac-address=${macAddress}`,
//       `=comment=${comment}`,
//       `=server=${dhcpServer}`,
//     ]);

//     if (expirationTimestamp) {
//       await redis.set(`wifi_lease_${macAddress}`, expirationTimestamp);
//     }

//     return { success: true, message: `Added address lease to pool: ${addressPool} for MAC: ${macAddress} with comment: ${comment}${durationMessage}` };
//   } catch (error) {
//     console.error('Error adding WiFi user:', error.message);
//     return { success: false, error: error.message };
//   }
// };

const addWifiUser = async ({ poolName, macAddress, comment = '', daysUntilExpiration = null, isTestMode = false }) => {
  // Validate the address pool
  const addressPool = poolMapping[poolName];
  const dhcpServer = dhcpServerMapping[poolName] || 'Unknown';

  if (!addressPool) {
    throw new Error('Invalid address pool specified. Use /staff, /nonstaff, /contractor, etc.');
  }

  // Clean up MAC address (remove colons if present)
  macAddress = macAddress.replace(/:/g, '');

  let expirationTimestamp = null;
  let durationMessage = '';

  // Handle expiration time
  if (daysUntilExpiration) {
    const expirationDate = new Date();
    if (isTestMode) {
      expirationDate.setMinutes(expirationDate.getMinutes() + parseInt(daysUntilExpiration));
      durationMessage = ` with an expiration of ${daysUntilExpiration} minutes (test mode)`;
    } else {
      expirationDate.setDate(expirationDate.getDate() + parseInt(daysUntilExpiration));
      durationMessage = ` with an expiration of ${daysUntilExpiration} days`;
    }
    expirationTimestamp = expirationDate.getTime();
  }

  try {
    const conn = await connectRouterOS();
    const data = await conn.write('/ip/dhcp-server/lease/add', [
      `=address=${addressPool}`,
      `=mac-address=${macAddress}`,
      `=comment=${comment}`,
      `=server=${dhcpServer}`,
    ]);

    // Set expiration in Redis if applicable
    if (expirationTimestamp) {
      const ttl = Math.floor((expirationTimestamp - Date.now()) / 1000); // TTL in seconds
      await redis.set(`wifi_lease_${macAddress}`, expirationTimestamp, 'EX', ttl);
    }

    conn.close();

    return { success: true, message: `Added address lease to pool: ${addressPool} for MAC: ${macAddress} with comment: ${comment}${durationMessage}` };
  } catch (error) {
    console.error('Error adding WiFi user:', error); // Log full error for debugging
    return { success: false, error: error.message };
  }
};


const deleteLease = async (conn, macAddress, leaseId, retries = 3) => {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await conn.write('/ip/dhcp-server/lease/remove', [`=numbers=${leaseId}`]);
      console.log(`Successfully deleted lease for MAC: ${macAddress} on attempt ${attempt}`);
      return;
    } catch (error) {
      console.error(`Error deleting lease for MAC: ${macAddress} on attempt ${attempt}:`, error.message);
      if (attempt === retries) {
        throw error;
      }
    }
  }
};

const cleanupExpiredLeases = async (conn) => {
  try {
    const currentTimestamp = Date.now();
    console.log(`Current Timestamp: ${currentTimestamp}`);

    const keys = await redis.keys('wifi_lease_*');
    console.log(`Found ${keys.length} keys in Redis`);

    for (const key of keys) {
      const expirationTimestamp = await redis.get(key);
      let macAddress = key.replace('wifi_lease_', ''); // Extract MAC address from the key

      // Format the MAC address correctly
      const formattedMacAddress = macAddress.match(/.{1,2}/g).join(':');
      console.log(`Processing key: ${key}, Formatted MAC Address: ${formattedMacAddress}, Expiration: ${expirationTimestamp}`);
      console.log(`Parsed Expiration Timestamp: ${parseInt(expirationTimestamp)}, Current Timestamp: ${currentTimestamp}`);

      // Adding a buffer of 5 seconds (5000 milliseconds) to account for timing differences
      if (expirationTimestamp && parseInt(expirationTimestamp) + 5000 < currentTimestamp) {
        // Retrieve lease information before deletion
        const leaseInfo = await conn.write('/ip/dhcp-server/lease/print', [`?mac-address=${formattedMacAddress}`]);
        console.log(`Lease Info for ${formattedMacAddress}:`, JSON.stringify(leaseInfo, null, 2));

        if (leaseInfo.length > 0) {
          const lease = leaseInfo[0];
          const comment = lease['comment'] || 'No comment'; // Provide default value if comment is not available
          const expirationDate = new Date(parseInt(expirationTimestamp)).toLocaleString();
          console.log(`Expiration Date: ${expirationDate}, Comment: ${comment}`);
          console.log(`Deleting expired lease for MAC: ${formattedMacAddress}`);

          try {
            await deleteLease(conn, formattedMacAddress, lease['.id']);
            console.log(`Successfully deleted lease for MAC: ${formattedMacAddress}`);
            await redis.del(key);  // Delete from Redis only if RouterOS deletion was successful
            const testNumber = phoneNumberFormatter('085712612218');
            await sock.sendMessage('120363268682582007@g.us', { text: `Deleted expired lease for MAC: ${formattedMacAddress} with expiration date: ${expirationDate} and comment: ${comment}` });
            //await sock.sendMessage(testNumber, { text: `Deleted expired lease for MAC: ${formattedMacAddress} with expiration date: ${expirationDate} and comment: ${comment}` });
          } catch (error) {
            console.error(`Failed to delete lease for MAC: ${formattedMacAddress} after multiple attempts`);
          }
        } else {
          console.log(`No lease info found for MAC: ${formattedMacAddress}`);
        }
      } else {
        console.log(`Expiration timestamp not valid or in the past for MAC: ${formattedMacAddress}`);
      }
    }

    console.log('Lease cleanup completed.');
  } catch (error) {
    console.error('Error cleaning up expired leases:', error.message);
  }
};


const handleLeaseReport = async (from) => {
  try {
    const conn = await connectRouterOS();  // Establish connection to RouterOS
    const keys = await redis.keys('wifi_lease_*');
    const currentTimestamp = Date.now();
    let report = '*Lease Report for Users with Limited Expiration Dates:*\n\n';
    let hasExpiredLeases = false;

    console.log(`Found ${keys.length} keys in Redis`);

    for (const key of keys) {
      const expirationTimestamp = await redis.get(key);
      let macAddress = key.replace('wifi_lease_', ''); // Extract MAC address from the key

      // Format the MAC address correctly
      macAddress = macAddress.match(/.{1,2}/g).join(':');
      console.log(`Processing key: ${key}, Formatted MAC Address: ${macAddress}, Expiration: ${expirationTimestamp}`);

      if (expirationTimestamp && parseInt(expirationTimestamp) > currentTimestamp) {
        const leaseInfo = await conn.write('/ip/dhcp-server/lease/print', [`?mac-address=${macAddress}`]);
        console.log(`Lease Info for ${macAddress}:`, JSON.stringify(leaseInfo, null, 2));

        if (leaseInfo.length > 0) {
          const lease = leaseInfo[0];
          console.log(`Lease found: ${JSON.stringify(lease, null, 2)}`);
          const expirationDate = new Date(parseInt(expirationTimestamp)).toLocaleString();
          const comment = lease['comment'];
          report += `*MAC Address:* ${macAddress}\n*Expires At:* ${expirationDate}\n*Comment:* ${comment}\n\n`;
          hasExpiredLeases = true;
        } else {
          console.log(`No lease info found for MAC: ${macAddress}`);
        }
      } else {
        console.log(`Expiration timestamp not valid or in the past for MAC: ${macAddress}`);
      }
    }

    if (!hasExpiredLeases) {
      report += 'No users with limited expiration dates found.';
    }

    await sock.sendMessage(from, { text: report });
    console.log('Lease report sent:', report);
    conn.close();  // Close the connection
  } catch (error) {
    console.error('Error generating lease report:', error);
    await sock.sendMessage(from, { text: 'Error generating lease report. Please try again later.' });
  }
};





// Schedule the cleanup task to run at midnight every day
// schedule.scheduleJob('0 0 * * *', async () => {
//   try {
//     const conn = await connectRouterOS();
//     await cleanupExpiredLeases(conn);
//     conn.close();
//   } catch (error) {
//     console.error('Error during scheduled cleanup:', error.message);
//   }
// });

// Schedule the cleanup task to run every 10 minutes
// Schedule the cleanup task to run every minute
schedule.scheduleJob('*/10 * * * *', async () => {
  try {
    const conn = await connectRouterOS();
    await cleanupExpiredLeases(conn);
    conn.close();
  } catch (error) {
    console.error('Error during scheduled cleanup:', error.message);
  }
});

// Schedule the update task to run once a day at midnight
schedule.scheduleJob('0 0 * * *', async () => {
  console.log('Running daily update for IT PRF Status sheet...');
  try {
      await onedrive.deleteExistingFile();
      const fileName = 'IT PRF MONITORING - Updated.xlsx';
      const worksheet = await onedrive.readITPRFStatusSheet(fileName);
      if (!worksheet) {
          console.log('Failed to read the IT PRF Status sheet.');
          return;
      }
      console.log('Daily update completed successfully.');
  } catch (error) {
      console.error('Error during daily update:', error.message);
  }
});

// const checkWifiStatus = async (conn, macAddress) => {
//     try {
//       const leases = await conn.write('/ip/dhcp-server/lease/print', [
//         `?mac-address=${macAddress}`,
//       ]);
  
//       let response = '';
  
//       if (leases.length > 0) {
//         // MAC address found in DHCP leases
//         const lease = leases[0]; // Assuming there is only one matching lease
//         const ipAddress = lease['address'];
//         const dhcpServer = lease['server'];
//         const hostName = lease['host-name']; // Extract hostname from the lease
//         const comment = lease['comment'];
  
//         response += `MAC Address: ${macAddress}\nIP Address: ${ipAddress}\nDHCP Server: ${dhcpServer}\n`;
  
//         if (comment) {
//           response += `Comment: ${comment}\n`;
//         } else {
//           response += `Comment not found in DHCP leases.\n`;
//         }
  
//         if (hostName) {
//           response += `Host Name: ${hostName}\n`;
//         } else {
//           response += `Host Name not found in DHCP leases.\n`;
//         }
//       } else {
//         // MAC address not found in DHCP leases
//         response += `MAC Address: ${macAddress} not found in DHCP leases.\n`;
//       }
  
//       return { success: true, message: response };
//     } catch (error) {
//       console.error('Error retrieving WiFi status:', error.message);
//       return { success: false, error: error.message };
//     }
// };

const checkWifiStatus = async (macAddress) => {
  try {
    // Clean and validate the MAC address
    macAddress = macAddress.replace(/[:\-]/g, ''); // Remove colons and hyphens
    if (!macAddress.match(/^[0-9A-Fa-f]{12}$/)) {
      return { success: false, message: 'Error: Invalid MAC address format. Ensure it is 12 hexadecimal characters long.' };
    }

    // Format the MAC address by adding colons and converting to uppercase
    macAddress = macAddress.match(/.{1,2}/g).join(':').toUpperCase();

    // Establish a connection to RouterOS
    const conn = await connectRouterOS();

    // Query the DHCP leases for the MAC address
    const leases = await conn.write('/ip/dhcp-server/lease/print', [
      `?mac-address=${macAddress}`,
    ]);

    let response = '';

    if (leases.length > 0) {
      // MAC address found in DHCP leases
      const lease = leases[0]; // Assuming there is only one matching lease
      const ipAddress = lease['address'];
      const dhcpServer = lease['server'];
      const hostName = lease['host-name']; // Extract hostname from the lease
      const comment = lease['comment'];

      response += `MAC Address: ${macAddress}\nIP Address: ${ipAddress}\nDHCP Server: ${dhcpServer}\n`;

      if (comment) {
        response += `Comment: ${comment}\n`;
      } else {
        response += `Comment not found in DHCP leases.\n`;
      }

      if (hostName) {
        response += `Host Name: ${hostName}\n`;
      } else {
        response += `Host Name not found in DHCP leases.\n`;
      }
    } else {
      // MAC address not found in DHCP leases
      response += `MAC Address: ${macAddress} not found in DHCP leases.\n`;
    }

    // Close the connection after execution
    conn.close();

    // Return success message
    return { success: true, message: response };

  } catch (error) {
    console.error('Error retrieving WiFi status:', error.message);
    return { success: false, message: `Error retrieving WiFi status: ${error.message}` };
  }
};


function generatePassword(key) {
  const modifiedKey = key
    .replace(/a/gi, '4')
    .replace(/i/gi, '1')
    .replace(/e/gi, '3')
    .replace(/o/gi, '0')
    .replace(/u/gi, '00');

  if (key.length < 5) {
    const additionalCharsNeeded = 5 - key.length;
    const additionalChars = randomstring.generate({
      length: additionalCharsNeeded,
      charset: '0123456789!@#$&*'
    });
    return `${modifiedKey.slice(0, 4)}${modifiedKey.slice(4)}`.replace(/\s/g, '') + additionalChars+'#Mb23';
  }

  return `${modifiedKey.slice(0, 4)}${modifiedKey.slice(4)}#Mb23`.replace(/\s/g, '');
}

async function addUserToGroup(user, groupName) {
  try {
    const client = await getLdapClient();
    const userDN = `CN=${user},${process.env.BASE_OU}`;
    const groupDN = `CN=${groupName},${process.env.BASE_OU}`;
    const change = new ldap.Change({
      operation: 'add',
      modification: { member: userDN },
    });

    await new Promise((resolve, reject) => {
      client.modify(groupDN, change, (err) => {
        client.unbind();
        if (err) return reject(err);
        resolve();
      });
    });

    console.log(`User ${user} added to group ${groupName} successfully`);
    return { success: true };
  } catch (error) {
    console.error(`Error adding user to group: ${error.message}`);
    return { success: false, error: error.message };
  }
}

const createUser = async ({
  username,
  name,
  title,
  department,
  email,
  directReport,
  phoneNumber,
  displayName,
  firstName,
  lastName,
  ou,
  company,
  office,
  password,
}) => {
  try {
    const client = await getLdapClient();
    const userDN = `CN=${name},${ou || process.env.BASE_OU}`;
    const entry = {
      cn: name,
      sn: lastName,
      givenName: firstName,
      displayName,
      mail: email,
      userPrincipalName: email,
      sAMAccountName: username,
      title,
      department,
      company,
      mobile: phoneNumber,
      manager: directReport,
      physicalDeliveryOfficeName: office,
      objectClass: ['top', 'person', 'organizationalPerson', 'user'],
      unicodePwd: Buffer.from(`"${password}"`, 'utf16le'),
      userAccountControl: '512',
    };

    return await new Promise((resolve) => {
      client.add(userDN, entry, (err) => {
        client.unbind();
        if (err) {
          if (err.code === 68) {
            return resolve({ success: false, error: `User ${username} already exists.` });
          }
          return resolve({ success: false, error: err.message });
        }
        console.log('User created successfully:', userDN);
        const userInfo = `* Full Name: ${name}\n* Title: ${title}\n* Department: ${department}\n* Email: ${email}\n* Password: ${password}\n* Phone: ${phoneNumber}\n\n`;
        resolve({ success: true, userInfo });
      });
    });
  } catch (error) {
    console.error(`Unexpected error creating user: ${error.message}`);
    return { success: false, error: error.message };
  }
};

//Original Reset Password Code

async function resetPassword(upn, newPassword, changePasswordAtNextLogon) {
  try {
    const client = await getLdapClient();
    const userDN = upn.includes(',') ? upn : `CN=${upn},${process.env.BASE_OU}`;
    const changes = [
      new ldap.Change({
        operation: 'replace',
        modification: {
          unicodePwd: Buffer.from(`"${newPassword}"`, 'utf16le'),
        },
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
    console.log(`Password reset for ${upn} successful`);
    return { success: true };
  } catch (error) {
    console.error(`Error resetting password: ${error.message}`);
    return { success: false, error: error.message };
  }
}

function parseBitLockerInfo(output) {
  const parsedInfo = {
    hostname: '',
    passwordId: '',
    recoveryPassword: ''
  };

  // Log the original output for debugging
  console.log('Original Output:', output); 
  // Merge multi-line DistinguishedName values into one continuous string
  const cleanedOutput = output.replace(/\r?\n\s+/g, ' ').replace(/\n/g, ' '); // Merge all lines into one single string
  console.log('Cleaned Output:', cleanedOutput); // Log the cleaned output for verification

  // Split the cleaned output into segments
  const lines = cleanedOutput.split('msFVE-RecoveryPassword').map(line => line.trim()).filter(Boolean);
  console.log(`Parsed ${lines.length} segments from cleaned output.`); // Log the number of segments parsed

  lines.forEach((line, index) => {
    console.log(`Processing segment ${index + 1}: ${line}`); // Log each segment being processed

    // Extract the recovery password
    const recoveryPasswordMatch = line.match(/:\s*([A-Z0-9-]{36,})/);
    if (recoveryPasswordMatch) {
      parsedInfo.recoveryPassword = recoveryPasswordMatch[1].trim();
      console.log(`Extracted Recovery Password: ${parsedInfo.recoveryPassword}`); // Log the extracted recovery password
    }

    // Extract the DistinguishedName
    const distinguishedNameMatch = line.match(/DistinguishedName\s*:\s*(.+)/);
    if (distinguishedNameMatch) {
      const distinguishedName = distinguishedNameMatch[1].trim();
      console.log(`Extracted Distinguished Name: ${distinguishedName}`); // Log the extracted distinguished name

      // Extract the second occurrence of 'CN=', which is the actual hostname
      const cnMatches = distinguishedName.match(/CN=([^,]+)/g);
      if (cnMatches && cnMatches.length > 1) {
        parsedInfo.hostname = cnMatches[1].replace('CN=', ''); // Extract the second CN as hostname
        console.log(`Extracted Hostname: ${parsedInfo.hostname}`); // Log the extracted hostname
      }

      // Extract the password ID (the GUID in curly braces)
      const passwordIdMatch = distinguishedName.match(/{([^}]+)}/);
      if (passwordIdMatch) {
        parsedInfo.passwordId = passwordIdMatch[1]; // Extract GUID
        console.log(`Extracted Password ID: ${parsedInfo.passwordId}`); // Log the extracted password ID
      }
    }
  });

  console.log('Parsed BitLocker Info:', parsedInfo); // Log the final parsed information
  return parsedInfo;
}

async function getBitLockerInfo(hostname) {
  console.log(`Getting BitLocker info for ${hostname}`);
  let client;

  try {
    client = await getLdapClient();
    console.log('LDAP client connected');
    const baseDN = process.env.LDAP_BASE_DN;
    console.log('Using Base DN:', baseDN);

    const h = hostname.toUpperCase();
    const compFilter = `(&(objectCategory=computer)(|(cn=${h})(sAMAccountName=${h}$)))`;
    console.log('→ computer filter:', compFilter);

    // 1) Locate the computer object
    let compEntries = await search(baseDN, compFilter);
    if (compEntries.length === 0) {
      const wcFilter = `(&(objectCategory=computer)(cn=${h}*))`;
      console.log('→ wildcard fallback filter:', wcFilter);
      compEntries = await search(baseDN, wcFilter);
    }
    console.log(' exact match returned', compEntries.length, 'entries');

    if (compEntries.length === 0) {
      client.unbind();
      return { success: false, error: `Computer "${hostname}" not found in AD` };
    }

    const computerDN = compEntries[0].dn;
    console.log('Found computer DN:', computerDN);

    // 2) One-level search for any child with a password attribute
    const blEntries = await search(
      computerDN,
      '(msFVE-RecoveryPassword=*)',
      ['msFVE-RecoveryPassword'],
      'one'
    );
    console.log(' found', blEntries.length, 'BitLocker entries');
    client.unbind();

    if (blEntries.length === 0) {
      return { success: false, error: 'No BitLocker recovery objects found' };
    }

    // 3) Map into partition/key list
    const keys = blEntries.map(e => ({
      partitionId: e.dn.split(',')[0].replace(/^CN=/, ''),
      password:    e.password      // guaranteed to be set below
    }));

    return {
      success: true,
      data: { hostname, keys }
    };

  } catch (err) {
    if (client) client.unbind();
    console.error('Error in getBitLockerInfo:', err);
    return { success: false, error: err.message };
  }

  /** Helper: LDAP search returning array of { dn, password } */
  async function search(searchBase, filter, attrs = [], scope = 'sub') {
    return new Promise((resolve, reject) => {
      const results = [];
      client.search(
        searchBase,
        { scope, filter, attributes: attrs },
        (err, res) => {
          if (err) return reject(err);
          res.on('searchEntry', entry => {
            const dnString = entry.dn.toString();    // convert LdapDn to string
            const obj      = { dn: dnString };
            for (const attr of entry.attributes) {
              const name = attr.type.toLowerCase();
              if (name === 'msfve-recoverypassword') {
                // ALWAYS use .values, never .vals
                obj.password = attr.values[0] || '';
              }
            }
            console.log('  • entry:', obj.dn, '→ password:', obj.password ? '[OK]' : '[MISSING]');
            results.push(obj);
          });
          res.on('error', reject);
          res.on('end', () => resolve(results));
        }
      );
    });
  }
}



// Commented out to prevent LDAP connection error during startup
// const result = await getBitLockerInfo('mti-nb-177');
// if (result.success) {
//   const { hostname, password } = result.data;
//   console.log(`${hostname} → recovery key: ${password}`);
// } else {
//   console.error(`Error for ${result.hostname}: ${result.error}`);
// }




// const handleNewUserMessage = async (sock, msg, sender) => {
//   try {
//     const fileName = extractFileName(msg);
//     const caption = extractMessageContent(msg);
//     if (!caption.startsWith('/newuser'))return;
//     console.log(fileName);
//     if (!fileName || path.extname(fileName).toLowerCase() !== '.xlsx') {
//       await sock.sendMessage(sender, { text: 'Invalid file type. Please send an Excel file (.xlsx).' });
//       return;
//     }
//     // Check if the document is a file or a link to OneDrive
//     const documentMessage = msg.message.documentMessage || msg.message.documentWithCaptionMessage.message.documentMessage;
//     if (documentMessage) {
//       const filename = extractFileName(msg);
      
//       const buffer = await downloadMediaMessage(
//         msg,
//         'buffer',
//         {},
//         {
//           logger: Pino({ level: 'silent' }), // Adjust the logger level as necessary
//           reuploadRequest: sock.updateMediaMessage
//         }
//       );

//       const workbook = new ExcelJS.Workbook();
//       await workbook.xlsx.load(buffer);

//       const sheet = workbook.getWorksheet('List New Hire');
//       if (!sheet) {
//         await sock.sendMessage(sender, { text: 'Sheet "List New Hire" not found.' });
//         return;
//       } else {
//         sock.sendMessage(sender, { text: 'Processing the data, please wait...' });

//         const headers = sheet.getRow(1).values;
//         let formattedData = [];

//         sheet.eachRow((row, rowNumber) => {
//           if (rowNumber === 1) return; // Skip the header row
//           try{
//             const rowData = {};
//             row.eachCell((cell, colNumber) => {
//               let cellValue = cell.value;
//               if (cellValue && typeof cellValue === 'object' && cellValue.text) {
//                 cellValue = cellValue.text; // Extract the text property
//               }
//               rowData[headers[colNumber]] = cellValue;
//             });
  
//             // Extract and log each column's value
//             const name = rowData['Name'];
//             const title = rowData['Title'];
//             const department = rowData['Department'];
//             const email = rowData['Email'];
//             let directReport = rowData['Direct Report'];
//             let phoneNumber = rowData['No HP'] ? rowData['No HP'].toString().replace(/\D/g, '') : ''; // Remove non-digit characters if available

//             if (phoneNumber) { // Ensure phone number is not empty
//                 if (phoneNumber.startsWith('0')) {
//                     phoneNumber = '62' + phoneNumber.slice(1); // Standardize to 62857xxxxxxx format
//                 } else if (!phoneNumber.startsWith('62')) {
//                     phoneNumber = '62' + phoneNumber; // Prepend '62' if it doesn't start with '62'
//                 }
//             }
            
//             const accountCreationStatus = rowData['Account Creation'];
  
//             // Skip processing if Account Creation status is "Done"
//             if (accountCreationStatus && accountCreationStatus.trim().toLowerCase() === 'done') {
//               return;
//             }
  
//             const username = typeof email === 'string' ? email.split('@')[0] : '';
//             directReport = typeof directReport === 'string' ? directReport.split('@')[0] : '';
            
//             const displayName = `${name} [MTI]`;
//             let nameParts = name.split(' ');
//             let firstName = nameParts[0];
//             let lastName = nameParts.slice(1).join(' ').trim();
  
//             const password = generatePassword(firstName);
//             let ou = `OU=${department},OU=Merdeka Tsingshan Indonesia,DC=mbma,DC=com`;
//             const company = "PT. Merdeka Tsingshan Indonesia";
//             const office = 'Morowali';
//             let acl;
  
//             // Determine ACL for the users
//             if (department === "Occupational Health and Safety" || department === "Environment") {
//               acl = "ACL MTI OHSE";
//             } else if (department === "Copper Cathode Plant") {
//               ou = `OU=CCP,OU=Merdeka Tsingshan Indonesia,DC=mbma,DC=com`;
//               acl = `ACL MTI ${department.replace(' Plant', '')}`;
//             } else {
//               acl = `ACL MTI ${department.replace(' Plant', '')}`;
//             }
//             formattedData.push({
//               username,
//               name,
//               title,
//               department,
//               email,
//               directReport,
//               phoneNumber,
//               displayName,
//               firstName,
//               lastName,
//               ou,
//               company,
//               office,
//               password,
//               acl,
//               // Add other fields here...
//             }); 
//             console.log(`Processed Row ${rowNumber}:`, formattedData);
//           }
//           catch (error) {
//             console.error(`Error processing row ${rowNumber}:`, error.message);
//             sock.sendMessage(sender, { text: `Skipping row ${rowNumber} due to data error: ${error.message}. Please try again.` })
//               .catch(sendError => console.error('Error sending message:', sendError.message));
//           }
//           //console.log(`Row ${rowNumber} - Name: ${name}, Title: ${title}, Department: ${department}, Email: ${email}, Direct Report: ${directReport}, Phone Number: ${phoneNumber}, Username: ${username}, Account Creation Status: ${accountCreationStatus}`);
//         });
//            // Write the result into an Excel file
//         const workbookOutput = new ExcelJS.Workbook();
//         const worksheetOutput = workbookOutput.addWorksheet('User Creation Report');

//         // Add headers to the output worksheet
//         const outputHeaders = ['Username', 'Name', 'Title', 'Department', 'Email', 'Direct Report', 'Phone Number', 'Display Name', 'First Name', 'Last Name', 'OU', 'Company', 'Office', 'Password', 'ACL'];
//         worksheetOutput.addRow(outputHeaders);
        
//         // Add the formatted data to the worksheet
//         formattedData.forEach((row) => {
//           worksheetOutput.addRow([
//             row.username,
//             row.name,
//             row.title,
//             row.department,
//             row.email,
//             row.directReport,
//             row.phoneNumber,
//             row.displayName,
//             row.firstName,
//             row.lastName,
//             row.ou,
//             row.company,
//             row.office,
//             row.password,
//             row.acl,
//           ]);
//         });
        
//         const currentDate = new Date().toISOString().split('T')[0];
//         const reportFilePath = `User_Batch_${currentDate}.xlsx`;
//         await workbookOutput.xlsx.writeFile(reportFilePath);
//         const bufferOutput = fs.readFileSync(reportFilePath);

        
//         await sock.sendMessage(sender, { text: 'Data processing completed successfully!\nCreating AD Users.....' });

//         // Create AD users from the formatted data
//         let userCreationResults = [];

//         // Create AD users from the formatted data
//         for (const userData of formattedData) {
//           const result = await createUser(userData);
//           if (result.success) {
//             //Adding user to ACL and VPN Groups
//             await addUserToGroup(userData.username, userData.acl);
//             await addUserToGroup(userData.username, 'VPN-File_Server');
//             await addUserToGroup(userData.username, 'VPN-USERS');
//             userCreationResults.push(`User created successfully:\n${result.userInfo}`);
//           } else {
//             userCreationResults.push(`- Failed to create user ${userData.username}: ${result.error}`);
//             //return;
//           }
//         }
//         // Send the excel file along with user creation results as a caption
//         const captionText = userCreationResults.join('\n');

//         await sock.sendMessage(sender, {
//           document: bufferOutput,
//           mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
//           fileName: reportFilePath,
//           caption: captionText
//         });


//         fs.unlinkSync(reportFilePath);
//       }
//     } else {
//       await sock.sendMessage(sender, { text: 'No media file found. Please send an Excel file (.xlsx).' });
//     }
//   } catch (error) {
//     console.error('Error processing file:', error);
//     await sock.sendMessage(sender, { text: 'Error processing the file.' });
//   }
// };


const handleNewUserMessage = async (sock, msg, sender) => {
  try {
    
    const caption = extractMessageContent(msg);
    if (!caption.startsWith('/newuser'))return;

    // Check if the document is a file or a link to OneDrive
    const documentMessage = msg.message.documentMessage || msg.message.documentWithCaptionMessage?.message?.documentMessage;
    let sheet=null;
    if (!documentMessage) {
      try {
        await sock.sendMessage(sender, { text: 'Fetching file from OneDrive...' });
      
        // Use the existing readMTIMailingList() function to get the workbook
        //const sheet = await onedrive.readMTIMailingList();
        sheet = await onedrive.readMTIMailingList();
        if (!sheet) {
            await sock.sendMessage(sender, { text: 'Failed to read the sheet from OneDrive.' });
            return;
        }
      
      } catch (error) {
        console.error('Error fetching file from OneDrive:', error);
        await sock.sendMessage(sender, { text: 'An error occurred while fetching the file from OneDrive.' });
        return;
      }
    }
    if (documentMessage) {
      try {
        const fileName = extractFileName(msg);
        console.log(fileName);
        if (!fileName || path.extname(fileName).toLowerCase() !== '.xlsx') {
          await sock.sendMessage(sender, { text: 'Invalid file type. Please send an Excel file (.xlsx).' });
          return;
        }
        const buffer = await downloadMediaMessage(
          msg,
          'buffer',
          {},
          {
            logger: Pino({ level: 'silent' }), // Adjust the logger level as necessary
            reuploadRequest: sock.updateMediaMessage
          }
        );

        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.load(buffer);
        sheet = workbook.getWorksheet('List New Hire');
        //const sheet = workbook.getWorksheet('List New Hire');
        if (!sheet) {
          await sock.sendMessage(sender, { text: 'Sheet "List New Hire" not found.' });
          return;
        } 
      } catch (error) {
        console.error('Error processing the file:', error);
        await sock.sendMessage(sender, { text: 'An error occurred while processing the file.' });
      }

    } 

    //start processing data for user creation
    sock.sendMessage(sender, { text: 'Processing the data, please wait...' });

    const headers = sheet.getRow(1).values;
    let formattedData = [];

    sheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return; // Skip the header row
      try{
        const rowData = {};
        row.eachCell((cell, colNumber) => {
          let cellValue = cell.value;
          if (cellValue && typeof cellValue === 'object' && cellValue.text) {
            cellValue = cellValue.text; // Extract the text property
          }
          rowData[headers[colNumber]] = cellValue;
        });
        // row.eachCell((cell, colNumber) => {
        //   let cellValue = cell.value;
        
        //   if (cellValue && typeof cellValue === 'object') {
        //     if (cellValue.text) {
        //       // Extract plain text if available
        //       cellValue = cellValue.text;
        //     } else if (cellValue.richText) {
        //       // Handle richText by concatenating all parts into a single string
        //       cellValue = cellValue.richText.map(part => part.text).join('');
        //     }
        //   }
        
        //   rowData[headers[colNumber]] = cellValue;
        // });

        // Extract and log each column's value
        const name = rowData['Name'];
        const title = rowData['Title'];
        const department = rowData['Department'];

        let email = rowData['Email'];

        // Check if email is an object and handle different cases
        // Handle the case where `email` contains a formula
        email = (email && typeof email === 'object') ? (email.result || email.text || email.richText?.map(part => part.text).join('') || email.value || '') : email || '';
        console.log(`Email: ${email}`);

        let directReport = rowData['Direct Report'];
        let phoneNumber = rowData['No HP'] ? rowData['No HP'].toString().replace(/\D/g, '') : ''; // Remove non-digit characters if available
        const accountCreationStatus = rowData['Account Creation'];
        // // Handle object case for email field
        // if (email && typeof email === 'object') {
        //   email = email.text || email.richText?.map(part => part.text).join('') || ''; // Get the text value or the richText parts if applicable
        // }

        // Check if at least one mandatory field (except email) is filled
        if (name || title || department || directReport) {
            const missingFields = [];
            if (!name) missingFields.push('Name');
            if (!title) missingFields.push('Title');
            if (!department) missingFields.push('Department');
            if (!directReport) missingFields.push('Direct Report');

            // If there are missing fields, log them and skip the row
            if (missingFields.length > 0) {
                //console.log(`Skipping row ${rowNumber}: Missing fields: ${missingFields.join(', ')}`);
                const message = `Skipping row ${rowNumber}: Missing fields: ${missingFields.join(', ')}`;
                sock.sendMessage(sender, { text: message });
                console.log(message);
                return;
            }
        }
          // Email is mandatory, check if it's missing or incomplete
        if (!email || email === '@merdekabattery.com') {
            //console.log(`Skipping row ${rowNumber}: Incomplete or missing Email`);
            return;
        }
        

        if (phoneNumber) { // Ensure phone number is not empty
            if (phoneNumber.startsWith('0')) {
                phoneNumber = '62' + phoneNumber.slice(1); // Standardize to 62857xxxxxxx format
            } else if (!phoneNumber.startsWith('62')) {
                phoneNumber = '62' + phoneNumber; // Prepend '62' if it doesn't start with '62'
            }
        }
        
        // Skip processing if Account Creation status is "Done"
        if (accountCreationStatus && accountCreationStatus.trim().toLowerCase() === 'done') {
          console.log(`Skipping row ${rowNumber}: Account Creation status is "Done"`);
          return;
        }

        const username = typeof email === 'string' ? email.split('@')[0] : '';
        directReport = typeof directReport === 'string' ? directReport.split('@')[0] : '';
        
        const displayName = `${name} [MTI]`;
        let nameParts = name.split(' ');
        let firstName = nameParts[0];
        let lastName = nameParts.slice(1).join(' ').trim();

        const password = generatePassword(firstName);
        let ou = `OU=${department},OU=Merdeka Tsingshan Indonesia,DC=mbma,DC=com`;
        const company = "PT. Merdeka Tsingshan Indonesia";
        const office = 'Morowali';
        let acl;

        // Determine ACL for the users
        if (department === "Occupational Health and Safety" || department === "Environment") {
          acl = "ACL MTI OHSE";
        } else if (department === "Copper Cathode Plant") {
          ou = `OU=CCP,OU=Merdeka Tsingshan Indonesia,DC=mbma,DC=com`;
          acl = `ACL MTI ${department.replace(' Plant', '')}`;
        } else {
          acl = `ACL MTI ${department.replace(' Plant', '')}`;
        }
        formattedData.push({
          username,
          name,
          title,
          department,
          email,
          directReport,
          phoneNumber,
          displayName,
          firstName,
          lastName,
          ou,
          company,
          office,
          password,
          acl,
          // Add other fields here...
        }); 
        console.log(`Processed Row ${rowNumber}:`, formattedData);
      }
      catch (error) {
        console.error(`Error processing row ${rowNumber}:`, error.message);
        sock.sendMessage(sender, { text: `Skipping row ${rowNumber} due to data error: ${error.message}. Please try again.` })
          .catch(sendError => console.error('Error sending message:', sendError.message));
      }
      //console.log(`Row ${rowNumber} - Name: ${name}, Title: ${title}, Department: ${department}, Email: ${email}, Direct Report: ${directReport}, Phone Number: ${phoneNumber}, Username: ${username}, Account Creation Status: ${accountCreationStatus}`);
    });
        // Write the result into an Excel file
    const workbookOutput = new ExcelJS.Workbook();
    const worksheetOutput = workbookOutput.addWorksheet('User Creation Report');

    // Add headers to the output worksheet
    const outputHeaders = ['Username', 'Name', 'Title', 'Department', 'Email', 'Direct Report', 'Phone Number', 'Display Name', 'First Name', 'Last Name', 'OU', 'Company', 'Office', 'Password', 'ACL'];
    worksheetOutput.addRow(outputHeaders);
    
    // Add the formatted data to the worksheet
    formattedData.forEach((row) => {
      worksheetOutput.addRow([
        row.username,
        row.name,
        row.title,
        row.department,
        row.email,
        row.directReport,
        row.phoneNumber,
        row.displayName,
        row.firstName,
        row.lastName,
        row.ou,
        row.company,
        row.office,
        row.password,
        row.acl,
      ]);
    });
    
    const currentDate = new Date().toISOString().split('T')[0];
    const reportFilePath = `User_Batch_${currentDate}.xlsx`;
    await workbookOutput.xlsx.writeFile(reportFilePath);
    const bufferOutput = fs.readFileSync(reportFilePath);

    
    await sock.sendMessage(sender, { text: 'Data processing completed successfully!\nCreating AD Users.....' });

    // Create AD users from the formatted data
    let userCreationResults = [];

    // Create AD users from the formatted data
    for (const userData of formattedData) {
      const result = await createUser(userData);
      if (result.success) {
        //Adding user to ACL and VPN Groups
        console.log(`Adding user to ACL and VPN Groups for user: ${userData.username} with ACL: ${userData.acl}`);
        await addUserToGroup(userData.username, userData.acl);
        //await addUserToGroup(userData.username, 'VPN-File_Server');
        await addUserToGroup(userData.username, 'VPN-USERS');
        userCreationResults.push(`User created successfully:\n${result.userInfo}`);
      } else {
        userCreationResults.push(`- Failed to create user ${userData.username}: ${result.error}`);
        //return;
      }
    }
    // Send the excel file along with user creation results as a caption
    const captionText = userCreationResults.join('\n');

    await sock.sendMessage(sender, {
      document: bufferOutput,
      mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      fileName: reportFilePath,
      caption: captionText
    });


    fs.unlinkSync(reportFilePath);
    



  } catch (error) {
    console.error('Error processing file:', error);
    await sock.sendMessage(sender, { text: 'Error processing the file.' });
  }
};

async function answerAI(prompt) {
  try {
    const input = prompt;
    const chatCompletion = await openai.chat.completions.create({
      messages: [{ role: 'user', content: input }],
      model: 'gpt-4o', // Update with the appropriate OpenAI model version
    });
    
    return chatCompletion.choices[0].message.content;
  } catch (error) {
    console.error(error);
    throw new Error("Error processing AI chat completion: " + error.message);
  }
}



async function readImage(file, prompt) {
  try {
    const input = prompt;
    const chatCompletion = await openai.chat.completions.create({
      messages: [{ role: 'user', content: input }],
      model: 'gpt-4o', // Update with the appropriate OpenAI model version
    });
    
    return chatCompletion.choices[0].message.content;
  } catch (error) {
    console.error(error);
    throw new Error("Error processing AI chat completion: " + error.message);
  }
}

//Handle Image Prompt
function encodeImage(buffer) {
  return buffer.toString('base64');
}

// Function to analyze the image with a prompt
async function analyzeImageWithPrompt(base64Image, prompt) {
  try {
    // Prepare the message with the image and text
    const messages =[
      {
        "role": "user",
        "content": [
          {"type": "text", "text": prompt},
          {
            "type": "image_url",
            "image_url": {
              "url": `data:image/jpeg;base64,${base64Image}`,
            },
          },
        ],
      }
    ];

    // Send the request using OpenAI client
    const chatCompletion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: messages,
      max_tokens: 300,
    });

    // Extract the 'content' field from the response
    const contentResponse = chatCompletion.choices[0].message.content;

    return contentResponse;
  } catch (error) {
    console.error(error);
    throw new Error('Error processing AI chat completion: ' + error.message);
  }
}

// Function to handle image message with prompt
// Function to gather relevant information from the image
async function gatherImageInformation(base64Image, prompt) {
  try {
    // Use the same AI analysis function but modify the prompt to gather information instead of providing a solution
    const response = await analyzeImageWithPrompt(base64Image, `Gather information about this image. Context: ${prompt}`);
    return response;
  } catch (error) {
    console.error('Error gathering image information:', error);
    throw new Error('Unable to gather information from the image.');
  }
}

// async function gatherImageInformation(base64Image, prompt) {
//   try {
//     // Modify the prompt to gather detailed information, including objects, colors, and other contextual data
//     const detailedPrompt = `
//       Analyze the image and provide the following details:
//       1. Identify objects in the image and their names.
//       2. Describe the colors of the objects and background.
//       3. Identify any text or labels in the image.
//       4. Assess if there are any issues or problems visible in the image.
//       5. Provide any additional information that might help in diagnosing a problem or resolving the user's issue.
//       Context provided by the user: ${prompt}
//     `;

//     // Use the same AI analysis function but with the enhanced prompt
//     const response = await analyzeImageWithPrompt(base64Image, detailedPrompt);
//     return response;
//   } catch (error) {
//     console.error('Error gathering image information:', error);
//     throw new Error('Unable to gather detailed information from the image.');
//   }
// }

async function handleImageMessage(sock, msg, sender) {
  try {
      const caption = extractMessageContent(msg);
      console.log('Received message:', { caption });

      let prompt = caption; // Use the caption as the prompt directly

      // If the caption starts with /readImage, use the text after the command as the prompt
      const isReadImageCommand = caption && caption.toLowerCase().startsWith('/readimage');
      if (isReadImageCommand) {
          prompt = caption.substring(10).trim(); // Remove '/readImage' and use the rest as the prompt
      }

      // If there's no caption or no prompt, use a default prompt
      if (!prompt) {
          prompt = 'Gather relevant information from this image for further analysis.';
      }

      console.log('Using prompt:', prompt);

      // Check if the message contains an image
      const imageMessage = msg.message.imageMessage;
      if (!imageMessage) {
          console.warn('Message does not contain an image.');
          await sock.sendMessage(sender, { text: 'Please send an image along with your request.' });
          return;
      }

      console.log('Image detected with prompt:', { prompt });

      const fileName = extractFileName(msg);
      if (!isImageFile(fileName)) {
          console.warn('Invalid file type:', { fileName });
          await sock.sendMessage(sender, { text: 'Invalid file type. Please send an image file.' });
          return;
      }

      console.log('Downloading media file:', { fileName });

      // Download the media as a buffer
      const buffer = await downloadMediaMessage(
          msg, // The message object
          'buffer', // Download as buffer
          {}, // Options, can be left empty
          {
              logger: console, // Logging, replace with a logger if needed
              reuploadRequest: sock.updateMediaMessage, // Function to handle re-uploading if needed
          }
      );
      if (!Buffer.isBuffer(buffer)) {
          throw new Error('Failed to download media file as buffer');
      }

      console.log('Media file downloaded.');

      const base64Image = encodeImage(buffer);

      console.log('Image encoded to base64.');

      // Directly analyze the image with the provided prompt for /readimage
      if (isReadImageCommand) {
          console.log('Processing with /readimage command, using analyzeImageWithPrompt...');
          const analysisResult = await analyzeImageWithPrompt(base64Image, prompt);  // Directly use the analysis function
          console.log('AI image analysis completed for /readimage.');

          // Send the analysis result directly to the user
          await sock.sendMessage(sender, { text: `Image Analysis Result: ${analysisResult}` });
      } else {
          // If not /readimage, gather information and re-add prompt for assistant context
          console.log('Processing for assistant chat, gathering information...');
          const analysisResult = await gatherImageInformation(base64Image, prompt);  // Function to gather information, not provide a solution

          console.log('AI image information gathering completed.');

          // Feed the image information and the original caption (prompt) back to the assistant
          const combinedMessage = `User Caption: "${caption}"\n\nImage Information (focus on what user want, give feedback only what user need to know): ${analysisResult}`;
          console.log('Passing combined message to assistant:', combinedMessage);

          // Create a mock message object to pass to handleAssistantMessage
          const mockMessage = {
              key: {
                  remoteJid: sender
              },
              message: {
                  conversation: combinedMessage
              },
              pushName: "Image Analysis"
          };

          await handleAssistantMessage(sock, mockMessage, "Image Analysis");
      }

  } catch (error) {
      console.error('Error processing file:', error);
      await sock.sendMessage(sender, { text: 'Error processing the file.' });
  }
}


// async function handleImageMessage(sock, msg, sender) {
//   try {
//     const caption = extractMessageContent(msg);
//     console.log('Received message:', { caption });

//     let prompt = caption; // Use the caption as the prompt directly

//     // If the caption starts with /readImage, use the text after the command as the prompt
//     const isReadImageCommand = caption && caption.toLowerCase().startsWith('/readimage');
//     if (isReadImageCommand) {
//       prompt = caption.substring(10).trim(); // Remove '/readImage' and use the rest as the prompt
//     }

//     // If there's no caption or no prompt, use a default prompt
//     if (!prompt) {
//       prompt = 'Gather relevant information from this image for further analysis.';
//     }

//     console.log('Using prompt:', prompt);

//     // Check if the message contains an image
//     const imageMessage = msg.message.imageMessage;
//     if (!imageMessage) {
//       console.warn('Message does not contain an image.');
//       await sock.sendMessage(sender, { text: 'Please send an image along with your request.' });
//       return;
//     }

//     console.log('Image detected with prompt:', { prompt });

//     const fileName = extractFileName(msg);
//     if (!isImageFile(fileName)) {
//       console.warn('Invalid file type:', { fileName });
//       await sock.sendMessage(sender, { text: 'Invalid file type. Please send an image file.' });
//       return;
//     }

//     console.log('Downloading media file:', { fileName });

//     // Download the media as a buffer
//     const buffer = await downloadMediaMessage(
//       msg, // The message object
//       'buffer', // Download as buffer
//       {}, // Options, can be left empty
//       {
//         logger: console, // Logging, replace with a logger if needed
//         reuploadRequest: sock.updateMediaMessage, // Function to handle re-uploading if needed
//       }
//     );
//     if (!Buffer.isBuffer(buffer)) {
//       throw new Error('Failed to download media file as buffer');
//     }

//     console.log('Media file downloaded.');

//     const base64Image = encodeImage(buffer);

//     console.log('Image encoded to base64.');

//     // Directly analyze the image with the provided prompt for /readimage
//     if (isReadImageCommand) {
//       console.log('Processing with /readimage command, using analyzeImageWithPrompt...');
//       const analysisResult = await analyzeImageWithPrompt(base64Image, prompt);  // Directly use the analysis function
//       console.log('AI image analysis completed for /readimage.');

//       // Send the analysis result directly to the user
//       await sock.sendMessage(sender, { text: `Image Analysis Result: ${analysisResult}` });
//     } else {
//       // If not /readimage, gather information and re-add prompt for assistant context
//       console.log('Processing for assistant chat, gathering information...');
//       const analysisResult = await gatherImageInformation(base64Image, prompt);  // Function to gather information, not provide a solution

//       console.log('AI image information gathering completed.');

//       // Feed the image information and the original caption (prompt) back to the assistant
//       const combinedMessage = `User Caption: "${caption}"\n\nImage Information (focus on what user want, give feedback only what user need to know): ${analysisResult}`;
//       console.log('Passing combined message to assistant:', combinedMessage);

//       await handleAssistantMessage(sock, sender, combinedMessage, "Image Analysis");
//     }

//   } catch (error) {
//     console.error('Error processing file:', error);
//     await sock.sendMessage(sender, { text: 'Error processing the file.' });
//   }
// }




//LAST KNOWN WORKING CODE
// async function handleImageMessage(sock, msg, sender) {
//   try {
//     const caption = extractMessageContent(msg);
//     console.log('Received message:', { caption });

//     // Check if the message starts with /readImage
//     if (!caption.toLowerCase().startsWith('/readimage')) return;

//     // Extract the prompt from the caption
//     const prompt = caption.substring(10).trim(); // Remove '/readImage' and trim whitespace

//     if (!prompt) {
//       console.warn('No prompt provided after /readImage.');
//       await sock.sendMessage(sender, { text: 'Please resend with a prompt after /readImage.' });
//       return;
//     }

//     // Check if the message contains an image
//     const imageMessage = msg.message.imageMessage;
//     if (!imageMessage) {
//       console.warn('Message does not contain an image.');
//       await sock.sendMessage(sender, { text: 'Please send an image along with your request.' });
//       return;
//     }

//     console.log('Image detected with prompt:', { prompt });

//     const fileName = extractFileName(msg);
//     if (!isImageFile(fileName)) {
//       console.warn('Invalid file type:', { fileName });
//       await sock.sendMessage(sender, { text: 'Invalid file type. Please send an image file.' });
//       return;
//     }

//     console.log('Downloading media file:', { fileName });

//     // Download the media as a buffer
//     const buffer = await downloadMediaMessage(
//       msg, // The message object
//       'buffer', // Download as buffer
//       {}, // Options, can be left empty
//       {
//         logger: console, // Logging, replace with a logger if needed
//         reuploadRequest: sock.updateMediaMessage, // Function to handle re-uploading if needed
//       }
//     );
//     if (!Buffer.isBuffer(buffer)) {
//       throw new Error('Failed to download media file as buffer');
//     }

//     console.log('Media file downloaded.');

//     const base64Image = encodeImage(buffer);
    

//     console.log('Image encoded to base64.');
//     console.log(base64Image);

//     const response = await analyzeImageWithPrompt(base64Image, prompt);

//     console.log('AI analysis completed. Sending response to user.');

//     await sock.sendMessage(sender, { text: response });

//   } catch (error) {
//     console.error('Error processing file:', error);
//     await sock.sendMessage(sender, { text: 'Error processing the file.' });
//   }
// }


// Helper function to check if the file is an image
function isImageFile(fileName) {
  const mimeType = mime.lookup(fileName);
  return mimeType && mimeType.startsWith('image/');
}


//AI Assistant for MTI
const THREAD_EXPIRY_TIME = 1800; // 0.5 hour in seconds

// const storeThread = async (wa_id, thread_id) => {
//   await redis.set(wa_id, thread_id);
// };

const storeThread = async (wa_id, thread_id) => {
  // Check if the thread already exists
  const exists = await redis.exists(wa_id);

  if (exists) {
    // Reset the expiration time to the current moment + THREAD_EXPIRY_TIME
    await redis.expire(wa_id, THREAD_EXPIRY_TIME);
  } else {
    // If the thread doesn't exist, set it with the expiration time
    await redis.setex(wa_id, THREAD_EXPIRY_TIME, thread_id);
  }
};


const checkIfThreadExists = async (wa_id) => {
  const thread_id = await redis.get(wa_id);
  return thread_id;
};

const listAllThreads = async () => {
  try {
      const keys = await redis.keys('[0-9]*'); // Adjust pattern to match your wa_id format
      if (keys.length > 0) {
          console.log("List of all thread keys in Redis:");
          keys.forEach(key => console.log(`wa_id: ${key}`));
      } else {
          console.log("No thread keys found in Redis.");
      }
      return keys;
  } catch (err) {
      console.error("Error listing thread keys from Redis:", err);
  }
};

const clearAllThreadKeys = async () => {
  try {
      const keys = await redis.keys('[0-9]*');
      if (keys.length > 0) {
          await redis.del(keys);
          return { success: true, message: `Cleared ${keys.length} thread keys from Redis.` };
      } else {
          return { success: false, message: "No thread keys found in Redis." };
      }
  } catch (err) {
      console.error("Error clearing thread keys from Redis:", err);
      return { success: false, message: "Error clearing thread keys from Redis." };
  }
};

// Function to simulate typing before sending the message
const sendMessageWTyping = async (msg, jid) => {
  await sock.presenceSubscribe(jid);
  await delay(500); // Initial delay before typing

  // Calculate typing delay based on message length
  const typingSpeed = 50; // Characters per second
  const typingDelay = (msg.length / typingSpeed) * 1000; // Convert to milliseconds

  await sock.sendPresenceUpdate('composing', jid);
  await delay(typingDelay); // Wait for the calculated typing duration

  await sock.sendPresenceUpdate('paused', jid);

  await sock.sendMessage(jid, { text: msg });
};

// Function to cancel any active run in the thread
// async function cancelActiveRun(threadId) {
//   try {
//     // Retrieve all runs for the given thread
//     const runs = await openai.beta.threads.runs.list(threadId);
    
//     // Log all runs and their statuses for debugging purposes
//     console.log("Thread Runs:", runs.data.map(run => ({ id: run.id, status: run.status })));

//     // Find an active run that is not in a final state
//     const activeRun = runs.data.find(run => run.status !== "completed" && run.status !== "canceled" && run.status !== "failed");

//     if (activeRun) {
//       console.log(`Active run found with ID: ${activeRun.id} and status: ${activeRun.status}. Cancelling...`);
//       await openai.beta.threads.runs.cancel(threadId, activeRun.id);
//       console.log("Run cancelled successfully.");
//     } else {
//       console.log("No active runs to cancel.");
//     }
//   } catch (error) {
//     console.error("Error cancelling the run:", error);
//   }
// }

async function cancelActiveRun(threadId) {
  try {
    // Retrieve all runs for the given thread
    const runs = await openai.beta.threads.runs.list(threadId);

    // Log all runs and their statuses for debugging purposes
    console.log("Thread Runs:", runs.data.map(run => ({ id: run.id, status: run.status })));

    // Find an active run that is not in a final state and is not already cancelling
    const activeRun = runs.data.find(run => run.status !== "completed" && run.status !== "canceled" && run.status !== "failed" && run.status !== "cancelling");

    if (activeRun) {
      console.log(`Active run found with ID: ${activeRun.id} and status: ${activeRun.status}. Cancelling...`);
      await openai.beta.threads.runs.cancel(threadId, activeRun.id);
      console.log("Run cancelled successfully.");
    } else {
      console.log("No active runs to cancel.");
    }
  } catch (error) {
    console.error("Error cancelling the run:", error);
  }
}



// // Function to cancel any active run in the thread
// async function cancelActiveRun(threadId) {
//   try {
//     const runs = await openai.beta.threads.runs.list(threadId);
//     const activeRun = runs.data.find(run => run.status !== "completed");

//     if (activeRun) {
//       console.log("Active run found. Cancelling...");
//       await openai.beta.threads.runs.cancel(threadId, activeRun.id);
//       console.log("Run cancelled successfully.");
//     }
//   } catch (error) {
//     console.error("Error cancelling the run:", error);
//   }
// }
// Send WhatsApp Message is used to send message to a specific whatsapp ID
const sendWhatsAppMessage = async (sock, { jid, message }) => {
  try {
      // Check if jid and message are provided
      if (!jid) {
          throw new Error('The WhatsApp contact ID (jid) is not provided.');
      }
      if (!message) {
          throw new Error('The message content is not provided.');
      }

      // Format the phone number to the correct WhatsApp ID
      const formattedJid = phoneNumberFormatter(jid);

      // Log the jid and message for debugging
      console.log(`Sending message to: ${formattedJid}`);
      console.log(`Message content: ${message}`);

      // Extract the WhatsApp ID (wa_id) from the formatted jid
      const wa_id = formattedJid.split('@')[0];

      // Check if a thread for this receiver exists
      let thread_id = await checkIfThreadExists(wa_id);
      let isNewThread = false;

      if (!thread_id) {
          // If no thread exists, create a new one and add context to the AI
          console.log(`No thread found for ${wa_id}. Creating a new thread.`);
          const thread = await openai.beta.threads.create({
              messages: [
                  {
                      role: "user",
                      content: `Conversation started with message: "${message}"`,
                  },
              ],
          });

          thread_id = thread.id;
          isNewThread = true; // Mark this as a new thread
          console.log(`Created new thread for ${wa_id}: ${thread_id}`);
      }

      // Store the thread in Redis with an expiry time
      await storeThread(wa_id, thread_id);

      // Send the message to the specified formattedJid (destination number)
      await sock.sendMessage(formattedJid, { text: message });
      console.log(`Message sent to ${formattedJid}: ${message}`);

      // If this is a new thread, do not trigger an immediate AI response
      if (isNewThread) {
          console.log('New thread created. No immediate AI response will be triggered.');
          return { success: true, message: `Message sent to ${formattedJid}: ${message} (no AI response)` };
      }

      return { success: true, message: `Message sent to ${formattedJid}: ${message}` };

  } catch (error) {
      console.error(`Failed to send message to ${jid || 'undefined'}:`, error);
      return { success: false, message: `Failed to send message to ${jid || 'undefined'}` };
  }
};


const handleAssistantMessage = async (sock, message, pushName = "Unknown User") => {
  try {
    //const textWebhookUrl = 'https://n8n.merdekabattery.com:5678/webhook-test/whatsappw';
    //const textWebhookUrl = 'https://n8n.merdekabattery.com:5678/webhook-test/taskerai';
    //const textWebhookUrl = 'http://localhost:5678/webhook-test/7370e7c9-9fa9-4e20-a4a4-3caf6d84887d';
    //const textWebhookUrl = 'http://localhost:5678/webhook/whatsappw';
    //const textWebhookUrl = 'https://n8n.merdekabattery.com:5678/webhook/whatsappw';
    const textWebhookUrl = process.env.N8N_WEBHOOK_URL;
    const from = message.key.remoteJid;
    const wa_id = from.split('@')[0];

    // Attempt to look up the user; timeout after 5 seconds
    let user;
    try {
      user = await Promise.race([
        findUserByMobile(wa_id),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Timeout error: findUserByMobile took too long')), 5000)
        )
      ]);
    } catch (err) {
      console.error("User lookup error:", err);
      user = null;
    }

    let senderInformation;
    const contact = getContactByPhone(wa_id);
    try {
      if (contact) {
        console.log(`Contact found: ${contact.name}, ICT Name: ${contact.ict_name}`);
        const prefix = user && user.gender === 'Male' ? 'Bapak ' : user && user.gender === 'Female' ? 'Ibu ' : '';
        senderInformation = `Name: ${prefix}${user ? user.name : pushName}, Gender: ${user ? user.gender : "Unknown"}, WA ID: ${from}`;
      } else {
        console.log('Contact not found.');
        senderInformation = user 
          ? `Name: ${user.gender === 'Male' ? 'Bapak ' : 'Ibu '}${user.name}, Gender: ${user.gender}, Office email: ${user.email}, Department: ${user.department}, WA ID: ${from}`
          : `Name: ${pushName}, WA ID: ${from}`;
      }
      console.log(`Handling message from ${senderInformation} (${from})`);
    } catch (error) {
      console.error(`Unexpected error in sender info: ${error.message}`);
      console.error('Proceeding with default sender information.');
      senderInformation = `Name: ${pushName}`;
    }

    // Handle quoted message (if any)
    let quotedText = '';
    if (
      message.message.extendedTextMessage &&
      message.message.extendedTextMessage.contextInfo &&
      message.message.extendedTextMessage.contextInfo.quotedMessage
    ) {
      const quotedMessage = message.message.extendedTextMessage.contextInfo.quotedMessage;
      if (quotedMessage.conversation) {
        quotedText = quotedMessage.conversation;
        console.log(`Quoted message: ${quotedText}`);
      }
    }

    // Extract main text content
    const text = extractMessageContent(message);
    
    // Remove @mentions only for valid AI bot numbers before sending to N8N
    const validNumbers = ['6281145401505', '6281130569787', '214869110423796', '67328259653750'];
    let cleanText = text;
    validNumbers.forEach(number => {
        const regex = new RegExp(`@${number}`, 'g');
        cleanText = cleanText.replace(regex, '');
    });
    cleanText = cleanText.trim();
    
    let combinedMessage = quotedText ? `${quotedText}\n\nUser: ${cleanText}` : cleanText;
    const messageWithSenderInfo = `This message is from ${senderInformation}:\n\n${combinedMessage}`;

    // Build the payload for n8n
    const data = {
      from,
      wa_id,
      senderInformation,
      message: messageWithSenderInfo,
      originalText: cleanText,
      quotedText
    };

    // Post the payload to your n8n webhook using the httpsAgent and timeout configuration
    const response = await axios.post(textWebhookUrl, data, {
      httpsAgent: httpsAgent,
      timeout: 30000 // 30 seconds timeout
    });
    console.log('Text message forwarded to n8n, response:', response.data);

    // Use the reply from n8n to send a message back
    const assistantResponse = response.data.reply || response.data;
    if (assistantResponse) {
      //await sendMessageWTyping(assistantResponse, from);
      await sock.sendMessage(from, { text: assistantResponse });
      console.log(`Response sent to ${from}: ${assistantResponse}`);
    } else {
      console.error('Failed to get a response from n8n workflow');
    }
  } catch (err) {
    console.error(`Unexpected error in handleAssistantMessage:`, err);
  }
};

//LAST KNOWN WORKING CODE

// const handleAssistantMessage = async (sock, message, pushName = "Unknown User") => {
//   try {
//       const from = message.key.remoteJid;
//       const wa_id = from.split('@')[0];
//       const user = await Promise.race([
//           findUserByMobile(wa_id),
//           new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout error: findUserByMobile took too long')), 5000)) // 5 seconds timeout
//       ]);
//       let senderInformation;
//       const contact = getContactByPhone(wa_id);
//       try {
//           // Determine sender information
//           if (contact) {
//               console.log(`Contact found: ${contact.name}, ICT Name: ${contact.ict_name}`);
//               const prefix = user && user.gender === 'Male' ? 'Bapak ' : user && user.gender === 'Female' ? 'Ibu ' : '';
//               senderInformation = `Name: ${prefix}${user ? user.name : pushName || "Unknown User"}, Gender: ${user ? user.gender : "Unknown"}, WA ID: ${from}`;
//           } else {
//               console.log('Contact not found.');
//               senderInformation = user 
//                   ? `Name: ${user.gender === 'Male' ? 'Bapak ' : 'Ibu '}${user.name}, Gender: ${user.gender}, Office email: ${user.email}, Department: ${user.department}, WA ID: ${from}` 
//                   : `Name: ${pushName || "Unknown User"}, WA ID: ${from}`;
//           }

//           console.log(`Handling message from ${senderInformation} (${from})`);
//       } catch (error) {
//           console.error(`Unexpected error in handleAssistantMessage: ${error.message}`);
//           // Continue the process even if there's an error
//           console.error('An error occurred while determining sender information. Proceeding with default values.');
//           senderInformation = `Name: ${pushName || "Unknown User"}`; // Set default sender information
//       }

//       // Initialize variables for the quoted message
//       let quotedText = '';

//       // Check if the message is a reply/quoted message
//       if (message.message.extendedTextMessage && message.message.extendedTextMessage.contextInfo) {
//           const quotedMessage = message.message.extendedTextMessage.contextInfo.quotedMessage;
//           if (quotedMessage && quotedMessage.conversation) {
//               // Extract the quoted message content
//               quotedText = quotedMessage.conversation;
//               console.log(`Quoted message: ${quotedText}`);
//           }
//       }

//       // Extract the text content of the incoming message
//       const text = extractMessageContent(message);

//       // Combine quoted message with the new message if present
//       let combinedMessage = quotedText ? `${quotedText}\n\nUser: ${text}` : text;

//       // Check if the thread exists in Redis
//       let thread_id = await checkIfThreadExists(wa_id);
//       const messageWithSenderInfo = `This message is from ${senderInformation}  :\n\n${combinedMessage}`;
//       if (!thread_id) {
//           // Create a new thread if none exists
//           const thread = await openai.beta.threads.create({
//               messages: [
//                   {
//                       role: "user",
//                       content: messageWithSenderInfo
//                       //content: `This message is from ${senderInformation}: ${combinedMessage}`,
//                   },
//               ],
//           });

//           thread_id = thread.id;
//           console.log(`Created new thread for ${wa_id}: ${thread_id}`);
//       }

//       // Store the thread in Redis with an expiry time
//       await storeThread(wa_id, thread_id);

//       // Send the combined message to the assistant
//       const assistantIT = 'asst_qWqZBhBMUvWa0QE7LmPsQily';
//       const assistanntWidji= 'asst_19J4pz0RCFaODChBHyyTg2Vu';
//       const assistantCinta = 'asst_wY4tqIx8SID9xI3MXDStQ08w';
//       const assistantResponse = await sendMessageAndGetResponse(thread_id, assistantIT, messageWithSenderInfo);

//       if (assistantResponse) {
//           //await sendMessageWTyping(assistantResponse, from);
//           await sock.sendMessage(from, { text: assistantResponse });
//           console.log(`Response sent to ${from}: ${assistantResponse}`);
//       } else {
//           console.error('Failed to get a response from the assistant');
//       }

//   } catch (err) {
//       console.error(`Unexpected error in handleAssistantMessage:`, err);
//   }
// };


// const handleAssistantMessage = async (sock, from, text, pushName = "Unknown User") => {
//   try {
//       const wa_id = from.split('@')[0];
//       const user = await findUserByMobile(wa_id);
//       let senderInformation;
//       const contact = getContactByPhone(from.split('@')[0]);
//       if (contact) {
//           console.log(`Contact found: ${contact.name}, ICT Name: ${contact.ict_name}`);
//           senderInformation = `Name: ${user ? user.name : pushName || "Unknown User"}`;
//       } else {
//           console.log('Contact not found.');
//           senderInformation = user 
//               ? `Name: ${user.name}, Office email: ${user.email}, Department: ${user.department}` 
//               : `Name: ${pushName || "Unknown User"}`;
//       }
//       console.log(`Handling message from ${senderInformation} (${from})`);
//       let thread_id = await checkIfThreadExists(wa_id);

//       if (!thread_id) {
//           const thread = await openai.beta.threads.create({
//               messages: [
//                   {
//                       role: "user",
//                       content: `This message is from ${senderInformation}: ${text}`,
//                   },
//               ],
//           });
//           await storeThread(wa_id, thread.id);
//           thread_id = thread.id;
//           console.log(`Created new thread for ${wa_id}: ${thread_id}`);
//       }
//       assistantCinta = 'asst_wY4tqIx8SID9xI3MXDStQ08w';
//       assistantIT = 'asst_qWqZBhBMUvWa0QE7LmPsQily';
//       assistanntWidji= 'asst_19J4pz0RCFaODChBHyyTg2Vu';
//       const assistantResponse = await sendMessageAndGetResponse(thread_id, assistantIT, text);

//       if (assistantResponse) {
//           await sendMessageWTyping(assistantResponse, from);
//           //await sock.sendMessage(from, { text: assistantResponse });
//           console.log(`Response sent to ${from}: ${assistantResponse}`);
//       } else {
//           console.error('Failed to get a response from the assistant');
//       }

//   } catch (err) {
//       console.error(`Unexpected error in handleAssistantMessage:`, err);
//   }
// };


// AD lookup by mobile number (wa_id)
async function findUserByMobile(mobileNumber) {
  return new Promise((resolve, reject) => {
    const query = `mobile=${mobileNumber}`;
    admti.findUsers(query, false, (err, users) => {
      if (err) {
        console.error('Error finding user:', err);
        return reject(err);
      }

      if (!users || users.length === 0) {
        console.log('User not found in AD.');
        return resolve(null);
      }

      // Assuming the first match is the correct one
      const user = users[0];
      const userInfo = {
        name: user.displayName,
        email: user.mail,
        department: user.department,
        gender: user.gender
      };
      console.log('User found:', userInfo);
      resolve(userInfo);
    });
  });
}

// async function findUserByMobile(mobileNumber) {
//   return new Promise((resolve, reject) => {
//       const query = `mobile=${mobileNumber}`;
//       admti.findUsers(query, false, (err, users) => {
//           if (err) {
//               console.error('Error finding user:', err);
//               return reject(err);
//           }

//           if (!users || users.length === 0) {
//               console.log('User not found in AD.');
//               return resolve(null);
//           }

//           // Assuming the first match is the correct one
//           const user = users[0];
//           console.log('User found:', user.displayName);
//           resolve(user.displayName);
//       });
//   });
// }

// Define the real getWeather function
async function getWeather(location) {
  const apiKey = process.env.WEATHER_API_KEY;
  const url = `http://api.weatherapi.com/v1/current.json?key=${apiKey}&q=${location}&aqi=no`;

  try {
    const response = await axios.get(url);
    const weatherDescription = response.data.current.condition.text;
    const temperature = response.data.current.temp_c;
    const humidity = response.data.current.humidity;
    const windSpeed = response.data.current.wind_kph;

    return `Location: ${location}, Temperature: ${temperature}°C, Weather: ${weatherDescription}, Humidity: ${humidity}%, Wind Speed: ${windSpeed} kph`;
  } catch (error) {
    console.error("Error fetching weather data:", error);
    return `Could not fetch the weather for ${location}. Please check the location and try again.`;
  }
}

// Define the getCurrentDateTime function
async function getCurrentDateTime({ offsetDays = 0, includeTime = false, format = '' } = {}) {
  const date = new Date();
  
  // Apply the offset (if any)
  date.setDate(date.getDate() + offsetDays);

  // Format the date
  let formattedDate = date.toISOString().split('T')[0]; // Default to YYYY-MM-DD format

  if (includeTime) {
    const time = date.toTimeString().split(' ')[0]; // HH:mm:ss format
    formattedDate = `${formattedDate} ${time}`; // Combine date and time
  }

  return formattedDate;
}

// Function to find a user by their email
async function findUserByEmail(email) {
  return new Promise((resolve, reject) => {
      const query = `mail=${email}`;
      admti.findUsers(query, false, (err, users) => {
          if (err) {
              console.error('Error finding user:', err);
              return reject(`Error finding user: ${err.message}`);
          }

          if (!users || users.length === 0) {
              console.log('User not found in AD.');
              return resolve(null);
          }

          // Assuming the first match is the correct one
          const user = users[0];
          console.log('User found:', user.displayName);
          resolve(user.displayName);
      });
  });
}


async function findUserMobileByEmail(email) {
  return new Promise((resolve, reject) => {
      const query = `mail=${email}`;
      admti.findUsers(query, false, (err, users) => {
          if (err) {
              console.error('Error finding user:', err);
              return reject(`Error finding user: ${err.message}`);
          }

          if (!users || users.length === 0) {
              console.log('User not found in AD.');
              return resolve(null);
          }

          // Assuming the first match is the correct one
          const user = users[0];
          console.log('User found:', user.displayName);

          // Return the user's mobile number (stored in user.mobile)
          const mobile = user.mobile;
          if (mobile) {
              console.log('User mobile:', mobile);
              resolve(mobile);
          } else {
              console.log('Mobile number not found.');
              resolve(null);
          }
      });
  });
}


async function createTicket({ subject, description, email_id, service_category = null }) {
  // Step 1: Validate the email
  const user = await findUserByEmail(email_id);
  if (!user) {
    return `The email address ${email_id} is not registered. Please provide a valid email.`;
  }

  // Step 2: Proceed with ticket creation using handleCreateTicket
  const ticketResponse = await handleCreateTicket({ subject, description, email_id, service_category });
  return ticketResponse;
}


// Define the createTicket function with email validation


// async function createTicket({ subject, description, email_id }) {
//   // Step 1: Validate the email
//   const user = await findUserByEmail(email_id);
//   if (!user) {
//     return `The email address ${email_id} is not registered. Please provide a valid email.`;
//   }

//   // Step 2: Proceed with ticket creation
//   const createUrl = `${base_url}requests`;

//   // Input data for creating a new request
//   const inputData = {
//     request: {
//       subject: subject,
//       description: description,
//       requester: {
//         email_id: email_id
//       },
//       status: {
//         name: "Open"
//       },
//       priority: {
//         name: "Low"
//       },
//       template: {
//         is_service_template: false,
//         service_category: null,
//         name: "Submit a New Request",
//         id: "305"
//       }
//     }
//   };

//   // Convert the inputData to URL-encoded form data
//   const data = `input_data=${encodeURIComponent(JSON.stringify(inputData))}`;

//   try {
//     // Making the API request to create a new incident
//     const response = await axios.post(createUrl, data, { headers, httpsAgent: agent });
    
//     // Extracting the relevant details from the response
//     const requestId = response.data.request.id;
//     const summaryDescription = inputData.request.description;
//     const requesterEmail = inputData.request.requester.email_id;

//     // Returning a formatted response
//     return `Ticket created successfully with ID: ${requestId}, Summary: "${summaryDescription}", Requester Email: ${requesterEmail}.`;
//   } catch (error) {
//     console.error('Error creating request:', error.response ? error.response.data : error.message);
//     return "Could not create the ticket. Please try again later.";
//   }
// }

// async function createTicket({ subject, description, email_id, service_category = null }) {
//   // Step 1: Validate the email
//   const user = await findUserByEmail(email_id.toLowerCase());
//   if (!user) {
//     console.log(`The email address ${email_id} is not registered. Please provide a valid email.`);
//     return `The email address ${email_id} is not registered. Please provide a valid email.`;
//   }

//   // Step 2: Proceed with ticket creation
//   const createUrl = `${base_url}requests`;

//   // Input data for creating a new request
//   const inputData = {
//     request: {
//         subject: subject,
//         description: description,
//         requester: {
//             email_id: email_id
//         },
//         status: {
//             name: "Open"
//         },
//         priority: {
//             name: "Low"
//         },
//         template: {
//             is_service_template: false,
//             name: "Submit a New Request",
//             id: "305"
//         }
//     }
// };

// // Add service_category if provided
// if (service_category) {
//     inputData.request.service_category = { name: service_category };
// }

// // Convert the inputData to URL-encoded form data
// const data = `input_data=${encodeURIComponent(JSON.stringify(inputData))}`;

// try {
//     const response = await axios.post(createUrl, data, {
//         headers,
//         httpsAgent: agent // Using the HTTPS agent
//     });

//     // Successful creation
//     const requestId = response.data.request.id;
//     return `Ticket created successfully with ID: ${requestId}, Summary: "${description}", Requester Email: ${email_id}.`;
// } catch (error) {
//     if (error.response) {
//         console.error('HTTP error occurred:', error.message);
//         console.error('Response Data:', JSON.stringify(error.response.data, null, 2)); // Detailed error info
//     } else {
//         console.error('Request exception occurred:', error.message);
//     }
//     return "Could not create the ticket. Please try again later.";
// }
// }

// async function updateRequest(changeId, { templateId, templateName, isServiceTemplate = false, serviceCategory, status, technicianName, ictTechnician } = {}) {
//   if (!changeId) {
//       console.error('Invalid input parameters. Please provide changeId.');
//       return { success: false, message: 'Invalid input parameters. Please provide changeId.' };
//   }

//   const updateUrl = `${base_url}requests/${changeId}`;
//   const addResolutionUrl = `${updateUrl}/resolutions`;



//   // Prepare the request data to update
//   const updateData = {
//       request: {}
//   };

//   // Optionally include template details
//   if (templateId && templateName) {
//       updateData.request.template = {
//           is_service_template: isServiceTemplate,
//           service_category: serviceCategory ? { name: serviceCategory } : null,
//           name: templateName,
//           id: templateId
//       };
//   }

//   // Update status if provided
//   if (status) {
//       updateData.request.status = { name: status };
//   }
//   // Update service category if provided
//   if (serviceCategory) {
//       updateData.request.service_category = { name: serviceCategory };
//   }
//   // Update technician if provided
//   if (technicianName) {
//       updateData.request.technician = { name: technicianName };
//   }

//   // Update ICT Technician if provided
//   if (ictTechnician) {
//       updateData.request.udf_fields = {
//           udf_pick_601: ictTechnician  // Assuming udf_pick_601 is the correct field for ICT Technician
//       };
//   }

//   // Convert data to be URL-encoded
//   const data = `input_data=${encodeURIComponent(JSON.stringify(updateData))}`;
  
//   try {
//       console.log(`Sending request to update request with changeId: ${changeId}`);
//       const response = await axios.put(updateUrl, data, { headers, httpsAgent: new https.Agent({ rejectUnauthorized: false }) });
//       console.log(`Request with changeId: ${changeId} has been updated successfully.`);
//       return { success: true, message: `Request with changeId: ${changeId} has been updated successfully.` };
//   } catch (error) {
//       if (error.response) {
//           console.error(`HTTP error occurred while updating request for changeId: ${changeId}. Status: ${error.response.status}, Data:`, JSON.stringify(error.response.data));
//           return { success: false, message: `HTTP error occurred: ${error.response.data}` };
//       } else {
//           console.error(`An error occurred while updating request for changeId: ${changeId}. Message:`, error.message);
//           return { success: false, message: `An error occurred: ${error.message}` };
//       }
//   }
// }

// // Function to view request details
// async function view_request(request_id) {
//   const view_url = `${base_url}requests/${request_id}`;

//   try {
//       const response = await axios.get(view_url, {
//           headers: headers,
//           httpsAgent: new https.Agent({ rejectUnauthorized: false }) // Disable SSL verification
//       });

//       return response.data.request || {};

//   } catch (error) {
//       if (error.response) {
//           console.error(`HTTP error occurred: ${error.message}`);
//           console.error(error.response.data);
//       } else {
//           console.error(`Request exception occurred: ${error.message}`);
//       }
//       return {};
//   }
// }



// async function defineServiceCategory(changeId) {
//   try {
//     // Step 1: Retrieve the request data
//     const requestData = await view_request(changeId);
    
//     // Step 2: Extract the subject and description
//     const { subject, description } = requestData;

//     if (!subject && !description) {
//       console.error("No subject or description found for request.");
//       return null;
//     }

//     // Step 3: Prepare the input for the AI
//     const input = `Here is a list of service categories: ${serviceCategories.join(", ")}.\nBased on the following subject and description, select the most appropriate category:\n\nSubject: ${subject}\nDescription: ${description}, answer only with the service category`;

//     // Step 4: Call the AI to analyze the subject and description
//     let aiResponse;
//     try {
//       const chatCompletion = await openai.chat.completions.create({
//         messages: [{ role: 'user', content: input }],
//         model: 'gpt-4o-mini', // Use the appropriate model here
//       });
//       aiResponse = chatCompletion.choices[0].message.content;
//       console.log("AI Response:", aiResponse);
//     } catch (aiError) {
//       console.error("Error calling OpenAI:", aiError.message);
//       console.log("Defaulting to '15. Other' due to AI error.");
//       return '15. Other';
//     }

//     // Step 5: Match the AI's response to the service categories
//     for (const category of serviceCategories) {
//       if (aiResponse.toLowerCase().includes(category.split('. ')[1].toLowerCase())) {
//         console.log(`Service category determined: ${category}`);
//         return category; // Return the entire string like '01. PC/Laptop'
//       }
//     }

//     // Default if no match is found
//     console.log("No matching service category found. Defaulting to '15. Other'.");
//     return '15. Other';

//   } catch (error) {
//     console.error("Error defining service category:", error.message);
//     throw new Error("Error defining service category: " + error.message);
//   }
// }


// async function updateRequest(changeId, { templateId, templateName, isServiceTemplate = false, serviceCategory, status, technicianName, ictTechnician, resolution } = {}) {
//   if (!changeId) {
//       console.error('Invalid input parameters. Please provide changeId.');
//       return { success: false, message: 'Invalid input parameters. Please provide changeId.' };
//   }

//   const updateUrl = `${base_url}requests/${changeId}`;
//   const addResolutionUrl = `${updateUrl}/resolutions`;

//   // Prepare the request data to update
//   const updateData = {
//       request: {}
//   };

//   // Optionally include template details
//   if (templateId && templateName) {
//       updateData.request.template = {
//           is_service_template: isServiceTemplate,
//           service_category: serviceCategory ? { name: serviceCategory } : null,
//           name: templateName,
//           id: templateId
//       };
//   }

//   // Update status if provided
//   if (status) {
//       updateData.request.status = { name: status };
//   }
//   // Update service category if provided
//   if (serviceCategory) {
//       updateData.request.service_category = { name: serviceCategory };
//   }
//   // Update technician if provided
//   if (technicianName) {
//       updateData.request.technician = { name: technicianName };
//   }

//   // Update ICT Technician if provided
//   if (ictTechnician) {
//       updateData.request.udf_fields = {
//           udf_pick_601: ictTechnician  // Assuming udf_pick_601 is the correct field for ICT Technician
//       };
//   }

//   // Convert data to be URL-encoded
//   const data = `input_data=${encodeURIComponent(JSON.stringify(updateData))}`;
  
//   try {
//       // First, update the ticket
//       console.log(`Sending request to update request with changeId: ${changeId}`);
//       const response = await axios.put(updateUrl, data, { headers, httpsAgent: new https.Agent({ rejectUnauthorized: false }) });
//       console.log(`Request with changeId: ${changeId} has been updated successfully.`);

//       // If a resolution is provided, add it
//       if (resolution) {
//           console.log(`Adding resolution to request with changeId: ${changeId}`);
//           const resolutionData = {
//               resolution: {
//                   content: resolution
//               }
//           };

//           const resolutionPayload = `input_data=${encodeURIComponent(JSON.stringify(resolutionData))}`;

//           try {
//               const resolutionResponse = await axios.post(addResolutionUrl, resolutionPayload, { headers, httpsAgent: new https.Agent({ rejectUnauthorized: false }) });
//               console.log(`Resolution added successfully to request with changeId: ${changeId}.`);
//               return { success: true, message: `Request and resolution for changeId: ${changeId} have been updated successfully.` };
//           } catch (resolutionError) {
//               console.error(`Error occurred while adding resolution for changeId: ${changeId}.`, resolutionError.response ? resolutionError.response.data : resolutionError.message);
//               return { success: false, message: `Request updated but failed to add resolution: ${resolutionError.message}` };
//           }
//       }

//       return { success: true, message: `Request with changeId: ${changeId} has been updated successfully.` };

//   } catch (error) {
//       if (error.response) {
//           console.error(`HTTP error occurred while updating request for changeId: ${changeId}. Status: ${error.response.status}, Data:`, JSON.stringify(error.response.data));
//           return { success: false, message: `HTTP error occurred: ${error.response.data}` };
//       } else {
//           console.error(`An error occurred while updating request for changeId: ${changeId}. Message:`, error.message);
//           return { success: false, message: `An error occurred: ${error.message}` };
//       }
//   }
// }


//Last Known Good on 3 Nov 2024
// async function updateRequest(changeId, { templateId, templateName, isServiceTemplate = false, serviceCategory, status, technicianName, ictTechnician, resolution, priority = 'Low' } = {}) {
//   if (!changeId) {
//       console.error('Invalid input parameters. Please provide changeId.');
//       return { success: false, message: 'Invalid input parameters. Please provide changeId.' };
//   }

//   const updateUrl = `${base_url}requests/${changeId}`;
//   const addResolutionUrl = `${updateUrl}/resolutions`;

//   // Prepare the request data to update
//   const updateData = {
//       request: {}
//   };

//   // Optionally include template details
//   if (templateId && templateName) {
//       updateData.request.template = {
//           is_service_template: isServiceTemplate,
//           service_category: serviceCategory ? { name: serviceCategory } : null,
//           name: templateName,
//           id: templateId
//       };
//   }

//   // Update status if provided
//   if (status) {
//       updateData.request.status = { name: status };
//   }
//   // Update service category if provided
//   if (serviceCategory) {
//       updateData.request.service_category = { name: serviceCategory };
//   }
//   // Update technician if provided
//   if (technicianName) {
//       updateData.request.technician = { name: technicianName };
//   }

//   // Update ICT Technician if provided
//   if (ictTechnician) {
//       updateData.request.udf_fields = {
//           udf_pick_601: ictTechnician  // Assuming udf_pick_601 is the correct field for ICT Technician
//       };
//   }

//   // Set the priority (defaulting to "Low" if not provided)
//   updateData.request.priority = { name: priority };

//   // Convert data to be URL-encoded
//   const data = `input_data=${encodeURIComponent(JSON.stringify(updateData))}`;
  
//   try {
//       // First, update the ticket
//       console.log(`Sending request to update request with changeId: ${changeId}`);
//       const response = await axios.put(updateUrl, data, { headers, httpsAgent: new https.Agent({ rejectUnauthorized: false }) });
//       console.log(`Request with changeId: ${changeId} has been updated successfully.`);

//       // If a resolution is provided, add it
//       if (resolution) {
//           console.log(`Adding resolution to request with changeId: ${changeId}`);
//           const resolutionData = {
//               resolution: {
//                   content: resolution
//               }
//           };

//           const resolutionPayload = `input_data=${encodeURIComponent(JSON.stringify(resolutionData))}`;

//           try {
//               const resolutionResponse = await axios.post(addResolutionUrl, resolutionPayload, { headers, httpsAgent: new https.Agent({ rejectUnauthorized: false }) });
//               console.log(`Resolution added successfully to request with changeId: ${changeId}.`);
//               return { success: true, message: `Request and resolution for changeId: ${changeId} have been updated successfully.` };
//           } catch (resolutionError) {
//               console.error(`Error occurred while adding resolution for changeId: ${changeId}.`, resolutionError.response ? resolutionError.response.data : resolutionError.message);
//               return { success: false, message: `Request updated but failed to add resolution: ${resolutionError.message}` };
//           }
//       }

//       return { success: true, message: `Request with changeId: ${changeId} has been updated successfully.` };

//   } catch (error) {
//       if (error.response) {
//           console.error(`HTTP error occurred while updating request for changeId: ${changeId}. Status: ${error.response.status}, Data:`, JSON.stringify(error.response.data));
//           return { success: false, message: `HTTP error occurred: ${error.response.data}` };
//       } else {
//           console.error(`An error occurred while updating request for changeId: ${changeId}. Message:`, error.message);
//           return { success: false, message: `An error occurred: ${error.message}` };
//       }
//   }
// }



// async function get_all_requests() {
//   const all_url = `${base_url}requests`;
//   const params = {
//       list_info: {
//           row_count: 100,
//           start_index: 1,
//           sort_field: "created_time",
//           sort_order: "desc",  // Change sort order to descending to get newer dates first
//           get_total_count: true,
//           filter_by: {
//               id: "59"
//           }
//       }
//   };

//   try {
//       // Making the API request to get the list of all requests
//       const response = await axios.get(all_url, {
//           headers: headers,
//           params: { input_data: JSON.stringify(params) },
//           httpsAgent: new https.Agent({ rejectUnauthorized: false })  // Disable SSL verification
//       });

//       // Extracting request ID and created time from the response
//       const data = response.data;
//       const filtered_requests = [];
//       for (const request of data.requests || []) {
//           const request_id = request.id;
//           const created_time_str = request.created_time?.display_value;
//           if (created_time_str) {
//               const created_time = new Date(created_time_str);
//               if (created_time >= new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)) {  // Check if within last 7 days
//                   filtered_requests.push(request_id);
//               }
//           }
//       }
//       return filtered_requests;

//   } catch (error) {
//       if (error.response) {
//           console.error(`HTTP error occurred: ${error.message}`);
//           console.error(error.response.data);
//       } else {
//           console.error(`Request exception occurred: ${error.message}`);
//       }
//       return [];
//   }
// }



async function ticket_report_details() {
  const request_ids = await get_all_requests() || [];
  const report_data = [];

  for (const request_id of request_ids) {
      const request_details = await view_request(request_id);
      if (request_details) {
          const requester_name = request_details.requester?.name || 'N/A';
          const subject = request_details.subject || 'N/A'; // Keep subject in variable but don't use it
          const created_time = request_details.created_time?.display_value || 'N/A';
          const service_category = request_details.udf_fields?.udf_pick_301 || 'N/A';
          const status = request_details.status?.name || 'N/A';
          const ict_technician = request_details.udf_fields?.udf_pick_601 || 'N/A';
          const technician_name = request_details.technician?.name || 'N/A';
          report_data.push({
              request_id,
              requester_name,
              created_time,
              service_category,
              status,
              ict_technician,
              technician_name
          });
      }
  }

  // Building the report text
  let report_text = "Request ID, Requester Name, Requester Department, Created Time, Service Category, Status, ICT Technician, Technician Name\n";
  for (const data of report_data) {
      report_text += `${data.request_id}, ${data.requester_name}, ${data.requester_department}, ${data.created_time}, ${data.service_category}, ${data.status}, ${data.ict_technician}, ${data.technician_name}\n`;
  }

  // Adding the total number of tickets
  report_text += `\nTotal number of tickets: ${report_data.length}`;

  return report_text;
}

// const { plot } = require('nodeplotlib'); // Import nodeplotlib for plotting

// async function ticket_report_details() {
//   const request_ids = await get_all_requests();
//   const report_data = [];

//   for (const request_id of request_ids) {
//       const request_details = await view_request(request_id);
//       if (request_details) {
//           const requester_name = request_details.requester?.name || 'N/A';
//           const requester_department = request_details.requester?.department?.name || 'N/A';
//           const subject = request_details.subject || 'N/A'; // Keep subject in variable but don't use it
//           const created_time = request_details.created_time?.display_value || 'N/A';
//           const service_category = request_details.udf_fields?.udf_pick_301 || 'N/A';
//           const status = request_details.status?.name || 'N/A';
//           const ict_technician = request_details.udf_fields?.udf_pick_601 || 'N/A';
//           const technician_name = request_details.technician?.name || 'N/A';
//           report_data.push({
//               request_id,
//               requester_name,
//               requester_department,
//               created_time,
//               service_category,
//               status,
//               ict_technician,
//               technician_name
//           });
//       }
//   }

//   // Aggregate data by department
//   const departmentCounts = report_data.reduce((acc, data) => {
//       acc[data.requester_department] = (acc[data.requester_department] || 0) + 1;
//       return acc;
//   }, {});

//   // Sort departments by highest number of tickets
//   const sortedDepartments = Object.entries(departmentCounts)
//       .sort((a, b) => b[1] - a[1])
//       .map(([department, count]) => ({ department, count }));

//   // Prepare data for plotting
//   const departments = sortedDepartments.map(item => item.department);
//   const counts = sortedDepartments.map(item => item.count);

//   // Generate a unique color for each department
//   const colors = departments.map((_, index) => `hsl(${(index * 360) / departments.length}, 70%, 50%)`);

//   const plotData = [
//       {
//           x: departments,
//           y: counts,
//           type: 'bar',
//           text: counts.map(String),
//           textposition: 'auto',
//           hoverinfo: 'x+y',
//           marker: {
//               color: colors
//           }
//       }
//   ];

//   // Plot the data
//   plot(plotData, {
//       title: 'Number of Tickets by Department',
//       xaxis: { title: 'Department' },
//       yaxis: { title: 'Number of Tickets' }
//   });
// }

//const { plot } = require('nodeplotlib'); // Import nodeplotlib for plotting

// async function ticket_report_by_service_category() {
//   const request_ids = await get_all_requests();
//   const report_data = [];

//   for (const request_id of request_ids) {
//       const request_details = await view_request(request_id);
//       if (request_details) {
//           const service_category = request_details.service_category?.name || 'N/A';
//           report_data.push({
//               service_category
//           });
//       }
//   }

//   // Aggregate data by service category
//   const categoryCounts = report_data.reduce((acc, data) => {
//       acc[data.service_category] = (acc[data.service_category] || 0) + 1;
//       return acc;
//   }, {});

//   // Prepare data for plotting
//   const categories = Object.keys(categoryCounts);
//   const counts = Object.values(categoryCounts);

//   // Generate a unique color for each category
//   const colors = categories.map((_, index) => `hsl(${(index * 360) / categories.length}, 70%, 50%)`);

//   const plotData = [
//       {
//           labels: categories,
//           values: counts,
//           type: 'pie',
//           textinfo: 'label+percent',
//           hoverinfo: 'label+value+percent',
//           textposition: 'inside',
//           marker: {
//               colors: colors
//           },
//           insidetextfont: {
//               size: 10 // Adjust font size to fit labels better
//           },
//           outsidetextfont: {
//               size: 12 // Adjust font size for outside labels
//           }
//       }
//   ];

//   // Plot the data with adjusted layout to fit all text
//   plot(plotData, {
//       title: 'Ticket Distribution by Service Category',
//       margin: {
//           l: 50,   // Increase left margin
//           r: 50,   // Increase right margin
//           b: 50,   // Increase bottom margin
//           t: 50,   // Increase top margin
//           pad: 10  // Padding
//       },
//       height: 800, // Increased height
//       width: 1000,  // Increased width
//       showlegend: true, // Ensure the legend is shown
//   });
// }

// // Run the function
// ticket_report_by_service_category().catch(error => {
//     console.error('Error generating ticket report by service category:', error);
// });

// async function ticket_report_by_status() {
//   const request_ids = await get_all_requests();
//   const report_data = [];

//   for (const request_id of request_ids) {
//       const request_details = await view_request(request_id);
//       if (request_details) {
//           const status = request_details.status?.name || 'N/A';
//           report_data.push({
//               status
//           });
//       }
//   }

//   // Aggregate data by status
//   const statusCounts = report_data.reduce((acc, data) => {
//       acc[data.status] = (acc[data.status] || 0) + 1;
//       return acc;
//   }, {});

//   // Prepare data for plotting
//   const statuses = Object.keys(statusCounts);
//   const counts = Object.values(statusCounts);

//   // Generate a unique color for each status
//   const colors = statuses.map((_, index) => `hsl(${(index * 360) / statuses.length}, 70%, 50%)`);

//   const plotData = [
//       {
//           x: statuses,
//           y: counts,
//           type: 'bar',
//           text: counts.map(String),
//           textposition: 'auto',
//           hoverinfo: 'x+y',
//           marker: {
//               color: colors
//           }
//       }
//   ];

//   // Plot the data with adjusted margins to fit the graphic area
//   plot(plotData, {
//       title: 'Ticket Distribution by Status',
//       xaxis: { title: 'Status' },
//       yaxis: { title: 'Number of Tickets' },
//       height: 600,
//       width: 800,
//       margin: {
//           l: 50,   // Adjust left margin
//           r: 50,   // Adjust right margin
//           b: 100,  // Adjust bottom margin to fit labels
//           t: 50,   // Adjust top margin
//           pad: 10  // Padding
//       }
//   });
// }

// // Run the function
// ticket_report_by_status().catch(error => {
//     console.error('Error generating ticket report by status:', error);
// });




// const { parse } = require('json2csv'); // Import json2csv for converting JSON to CSV

// async function ticket_report_details_csv() {
//   const request_ids = await get_all_requests();
//   const report_data = [];

//   for (const request_id of request_ids) {
//       const request_details = await view_request(request_id);
//       if (request_details) {
//           const requester_name = request_details.requester?.name || 'N/A';
//           const requester_department = request_details.requester?.department?.name || 'N/A';
//           const subject = request_details.subject || 'N/A'; // Keep subject in variable but don't use it
//           const created_time = request_details.created_time?.display_value || 'N/A';
//           const service_category = request_details.service_category?.name || 'N/A';
//           const status = request_details.status?.name || 'N/A';
//           const ict_technician = request_details.udf_fields?.udf_pick_601 || 'N/A';
//           const technician_name = request_details.technician?.name || 'N/A';
//           report_data.push({
//               request_id,
//               requester_name,
//               requester_department,
//               subject,
//               created_time,
//               service_category,
//               status,
//               ict_technician,
//               technician_name
//           });
//       }
//   }

//   // Convert report data to CSV format
//   const csvFields = ['request_id', 'requester_name', 'requester_department', 'subject', 'created_time', 'service_category', 'status', 'ict_technician', 'technician_name'];
//   const csv = parse(report_data, { fields: csvFields });

//   // Write CSV to file
//   fs.writeFile('ticket_report.csv', csv, (err) => {
//       if (err) {
//           console.error('Error writing CSV file:', err);
//       } else {
//           console.log('CSV report has been generated: ticket_report.csv');
//       }
//   });
// }

// // Run the function
// ticket_report_details_csv().catch(error => {
//     console.error('Error generating ticket report details:', error);
// });




//last known good
// async function ticket_report() {
//   const request_ids = await get_all_requests();
//   const report_data = [];

//   for (const request_id of request_ids) {
//       const request_details = await view_request(request_id);
//       if (request_details) {
//           const requester_name = request_details.requester?.name || 'N/A';
//           const created_time = request_details.created_time?.display_value || 'N/A';
//           const service_category = request_details.service_category?.name || 'N/A';
//           const status = request_details.status?.name || 'N/A';
//           const ict_technician = request_details.udf_fields?.udf_pick_601 || 'N/A';
//           const technician_name = request_details.technician?.name || 'N/A';
//           report_data.push({
//               request_id,
//               requester_name,
//               created_time,
//               service_category,
//               status,
//               ict_technician,
//               technician_name
//           });
//       }
//   }

//   // Aggregating data by technician
//   const technician_data = {};
//   for (const data of report_data) {
//       const technician = data.ict_technician;
//       if (!technician_data[technician]) {
//           technician_data[technician] = {
//               status: {},
//               service_category: {}
//           };
//       }

//       // Count status
//       if (!technician_data[technician].status[data.status]) {
//           technician_data[technician].status[data.status] = 0;
//       }
//       technician_data[technician].status[data.status]++;

//       // Count service category
//       if (!technician_data[technician].service_category[data.service_category]) {
//           technician_data[technician].service_category[data.service_category] = 0;
//       }
//       technician_data[technician].service_category[data.service_category]++;
//   }

//   // Building the report text
//   let report_text = "";
//   for (const [technician, details] of Object.entries(technician_data)) {
//       report_text += `### ${technician}\n`;
//       report_text += `- Status:\n`;
//       for (const [status, count] of Object.entries(details.status)) {
//           report_text += `  - ${status}: ${count} Tiket\n`;
//       }
//       report_text += `- Service Category:\n`;
//       for (const [category, count] of Object.entries(details.service_category)) {
//           report_text += `  - ${category}: ${count} Tiket\n`;
//       }
//       report_text += `\n`;
//   }

//   return report_text;
// }

// async function main() {
//   const reportText = await ticket_report();
//   console.log(reportText);  // Or pass it to another function
// }

// main();

const newsapiKey = process.env.NEWS_API_KEY;

async function getNewsByFilters({
  query = '',
  sources = '',
  category = '',
  language = 'en',
  country = '',  // Default to 'id' (Indonesia)
  from = '',
  to = '',
  sortBy = 'publishedAt',
  pageSize = 10,
  page = 1,
  endpoint = 'top-headlines'
} = {}) {
  const baseUrl = 'https://newsapi.org/v2/';
  let url = `${baseUrl}${endpoint}?apiKey=${newsapiKey}`;

  // Manually build the query string based on provided parameters
  if (category) url += `&q=${encodeURIComponent(category)}`;
  if (sources) url += `&sources=${encodeURIComponent(sources)}`;
  if (language) url += `&language=${encodeURIComponent(language)}`;
  if (country) url += `&country=${encodeURIComponent(country)}`;
  if (from) url += `&from=${encodeURIComponent(from)}`;
  if (to) url += `&to=${encodeURIComponent(to)}`;
  if (sortBy) url += `&sortBy=${encodeURIComponent(sortBy)}`;
  if (pageSize) url += `&pageSize=${encodeURIComponent(pageSize)}`;
  if (page) url += `&page=${encodeURIComponent(page)}`;

  try {
    const response = await axios.get(url);
    const articles = response.data.articles;

    if (articles.length === 0) {
      return `No news articles found for your query.`;
    }

    const formattedNews = articles.map((article, index) => {
      return `${index + 1}. ${article.title} - ${article.source.name}\nPublished at: ${article.publishedAt}\nDescription: ${article.description}\nURL: ${article.url}\n`;
    }).join('\n');

    return `Here are the top news articles:\n\n${formattedNews}`;
  } catch (error) {
    console.error("Error fetching news data:", error);
    return "Could not fetch the news. Please try again later.";
  }
}

async function sendMessageAndGetResponse(threadId, assistantId, userMessage) {
  try {
    console.log(`Starting process for thread ID: ${threadId} with assistant ID: ${assistantId}`);
    
    // Step 1: Cancel any active runs in the thread
    console.log("Cancelling any active runs...");
    await cancelActiveRun(threadId);

    // Step 2: Sanitize the userMessage by removing any tags like @username or @phone_number,
    // but allow email addresses from merdekabattery.com and merdekacoppergold.com
    const sanitizedMessage = userMessage.replace(/@(?!(merdekabattery\.com|merdekacoppergold\.com|esgenergymaterials\.com|s\.whatsapp\.net))\S+/g, '').trim();
    console.log(`Sanitized user message: "${sanitizedMessage}"`);


    // Step 3: Create a new message in the thread using the sanitized message
    console.log("Creating a new user message in the thread...");
    await openai.beta.threads.messages.create(threadId, { role: "user", content: sanitizedMessage });
    console.log("User message created successfully.");
    // const threadMessage = await openai.beta.threads.messages.create(threadId, { role: "user", content: sanitizedMessage });
    // console.log("User message created successfully:");
    // console.log(threadMessage);


    // Step 4: Create a new run to get the assistant's response
    console.log("Creating a new run for the assistant's response...");
    let run = await openai.beta.threads.runs.create(threadId, { assistant_id: assistantId });
    console.log(`Run created with ID: ${run.id}`);

    // Step 5: Handle the run status
    while (run.status !== "completed") {
      console.log(`Current run status: ${run.status}`);
      await new Promise(resolve => setTimeout(resolve, 100)); // Wait 500ms between checks
      run = await openai.beta.threads.runs.retrieve(threadId, run.id);

      if (run.status === 'requires_action') {
        console.log('Assistant requires action. Checking for function call or user input.');

        const toolOutputs = [];

        // Handle tool calls
        if (run.required_action && run.required_action.submit_tool_outputs && run.required_action.submit_tool_outputs.tool_calls) {
          const requiredActions = run.required_action.submit_tool_outputs.tool_calls;
          console.log(`Number of required actions: ${requiredActions.length}`);

          for (const action of requiredActions) {
            try {
              console.log(`Processing action: ${action.function.name}`);
              const functionArgs = JSON.parse(action.function.arguments);
              let outputMessage;

              // Handle different functions with a switch statement
              switch (action.function.name) {
                case 'getWeather':
                  console.log("Calling getWeather...");
                  const weatherResponse = await getWeather(functionArgs.location);
                  outputMessage = `Weather info: ${weatherResponse}`;
                  break;

                case 'sendWhatsAppMessage':
                  console.log("Calling sendWhatsAppMessage...");
                  const { jid, message } = functionArgs;
                  const sendMessageResponse = await sendWhatsAppMessage(sock, { jid, message });
                  outputMessage = `WhatsApp Message Status: ${sendMessageResponse.message}`;
                  break;

                case 'handleAlarm':
                  console.log("Calling handleAlarm...");
                  console.log("Function arguments:", functionArgs);
                  const alarmResponse = await handleAlarm(functionArgs.sock, functionArgs.from, functionArgs.input);
                  outputMessage = `Current Alarm Info: ${alarmResponse}`;
                  break;
                case 'modifyAlarmById':
                  console.log("Calling modifyAlarmById...");
                  const modifyAlarmResponse = await modifyAlarmById(functionArgs.from, functionArgs.alarmId, functionArgs.updates);
                  outputMessage = `Modified Alarm Info: ${modifyAlarmResponse}`;
                  break;
                case 'listAlarmsByCondition':
                  console.log("Calling listAlarmsByCondition...");
                  console.log("Function arguments:", functionArgs);
                  const conditionResponse = await listAlarmsByCondition(functionArgs.from, functionArgs.condition);
                  outputMessage = `Alarms matching condition: ${conditionResponse}`;
                  break;

                case 'getCurrentDateTime':
                  console.log("Calling getCurrentDateTime...");
                  const dateTimeResponse = await getCurrentDateTime(functionArgs);
                  outputMessage = `Current Date/Time: ${dateTimeResponse}`;
                  break;

                case 'createTicket':
                  console.log("Calling createTicket...");
                  const ticketResponse = await createTicket(functionArgs);
                  outputMessage = `Ticket Info: ${ticketResponse}`;
                  break;

                case 'updateRequest':
                  console.log("Calling updateRequest...");
                  const updateResponse = await updateRequest(functionArgs.changeId, functionArgs);
                  outputMessage = `Update Info: ${updateResponse}`;
                  break;

                case 'getCommandHelp':
                  console.log("Calling getCommandHelp...");
                  const helpResponse = await getCommandHelp(functionArgs);
                  outputMessage = `Command help: ${helpResponse}`;
                  break;

                case 'handleGetAsset':
                  console.log("Calling handleGetAsset...");
                  const assetResponse = await handleGetAsset(functionArgs);
                  outputMessage = `Asset information: ${assetResponse}`;
                  break;

                case 'handleFindUser':
                  console.log("Calling handleFindUser...");
                  const findUserResponse = await handleFindUser(functionArgs);
                  outputMessage = `User information: ${findUserResponse}`;
                  break;

                case 'ticket_report':
                  console.log("Calling ticket_report...");
                  console.log("Received functionArgs:", functionArgs);
                  const ticketReportResponse = await ticket_report(functionArgs);
                  console.log(`Ticket Report: ${ticketReportResponse}`);
                  outputMessage = `Ticket Report: ${ticketReportResponse}`;
                  break;

                case 'getAssetByTag':
                  console.log("Calling getAssetByTag...");
                  const assetByTagResponse = await getAssetByTag(functionArgs);
                  outputMessage = `Asset information: ${assetByTagResponse}`;
                  break;

                case 'getAssets':
                  console.log("Calling getAssets...");
                  const assetsResponse = await getAssets(functionArgs);
                  outputMessage = `Asset information: ${assetsResponse}`;
                  break;

                case 'handlePRFQuery':
                  console.log("Calling handlePRFQuery...");
                  const prfQueryResponse = await onedrive.handlePRFQuery(functionArgs);
                  outputMessage = `PRF Query Info: ${prfQueryResponse}`;
                  break;
                  
                case 'getAIBrowser':
                  console.log("Calling getAIBrowser with args:", functionArgs);
                  const aiBrowserResponse = await getAIBrowser(functionArgs.prompt || ''); // Ensure you pass the correct prompt
                  console.log("AI Browser Result:", aiBrowserResponse);
                  outputMessage = `AI Browser Result: ${aiBrowserResponse}`;
                  break;

                case 'addWifiUser':
                  console.log("Calling addWifiUser...");
                  // Pass functionArgs directly to addWifiUser
                  const wifiUserResponse = await addWifiUser(functionArgs);
                  // Handle the response and output the message
                  outputMessage = wifiUserResponse.success 
                    ? `WiFi User Added: ${wifiUserResponse.message}` 
                    : `Error Adding WiFi User: ${wifiUserResponse.error}`;
                  break;
                case 'checkwifi':
                  console.log("Calling checkWifiStatus...");
                  const checkWifiResponse = await checkWifiStatus(functionArgs.macAddress);
                  outputMessage = checkWifiResponse.success 
                    ? `WiFi Status: ${checkWifiResponse.message}` 
                    : `Error Checking WiFi Status: ${checkWifiResponse.error}`;
                  break;

                case 'getLicenses':
                  console.log("Calling getLicenses...");
                  const licensesResponse = await getLicenses(functionArgs);
                  outputMessage = `License Information: ${licensesResponse}`;
                  break;

                case 'getLicenseByName':
                  console.log("Calling getLicenseByName...");
                  const licenseByNameResponse = await getLicenseByName(functionArgs.identifier);
                  outputMessage = `License Details: ${licenseByNameResponse}`;
                  break;

                case 'getExpiringLicenses':
                  console.log("Calling getExpiringLicenses...");
                  const expiringLicensesResponse = await getExpiringLicenses(functionArgs);
                  outputMessage = `Expiring Licenses: ${expiringLicensesResponse}`;
                  break;

                case 'getLicenseUtilization':
                  console.log("Calling getLicenseUtilization...");
                  const licenseUtilizationResponse = await getLicenseUtilization();
                  outputMessage = `License Utilization Report: ${licenseUtilizationResponse}`;
                  break;

                default:
                  console.warn(`Function ${action.function.name} not recognized.`);
              }

              // Post-process the output message to replace double asterisks with single asterisks
              if (outputMessage) {
                outputMessage = outputMessage.replace(/\*\*/g, '*');
                toolOutputs.push({
                  tool_call_id: action.id,
                  output: outputMessage
                });
                console.log(`Processed action output: ${outputMessage}`);
              }
            } catch (err) {
              console.error(`Error handling function call ${action.function.name}:`, err);
            }
          }

          // Submit all tool outputs back to the assistant
          console.log("Submitting tool outputs back to the assistant...");
          await openai.beta.threads.runs.submitToolOutputs(threadId, run.id, {
            tool_outputs: toolOutputs
          });
          console.log("Tool outputs submitted successfully.");

          // Continue to the next iteration to check the updated run status
          continue;
        }
      }
    }

    // Final check after run completes
    if (run.status === "completed") {
      console.log("Run completed. Retrieving the final assistant message...");
      const allMessages = await openai.beta.threads.messages.list(threadId);
      const assistantMessage = allMessages.data.find(message => message.role === "assistant");

      if (assistantMessage && !assistantMessage.function_call) {
        let newMessage = assistantMessage.content[0].text.value;
        newMessage = newMessage.replace(/\*\*/g, '*');
        console.log("Final Generated Message:", newMessage);
        return newMessage;
      }
    }

  } catch (error) {
    console.error("Error during sendMessageAndGetResponse execution:", error);
    return null;
  }
}



function isTagged(message) {
  const tagPattern = /@(\d+)/; // Regex to match @ followed by numbers (phone numbers or LIDs)
  
  // Valid AI bot numbers and LIDs
  const validNumbers = [
    '6281145401505',    // Primary AI bot
    '6281130569787',    // Secondary AI bot  
    '214869110423796',  // Primary AI bot LID
    '67328259653750'    // Secondary AI bot LID (Call Center)
  ];
  
  const match = tagPattern.exec(message);
  if (match) {
      const taggedNumber = match[1];
      
      // Direct check against valid numbers (including LIDs)
      if (validNumbers.includes(taggedNumber)) {
          return true;
      }
  }
  
  return false;
}

// Function to get command details
async function getCommandHelp(command) {
  const commandDetails = {
    finduser: {
      usage: '/finduser <username>',
      description: 'Finds the user with the given username.',
      example: ['/finduser peggy', '/finduser johndoe'],
      details: 'Searches for users in the system based on the username. Returns details like email, title, department, and mobile number.',
    },
    resetpassword: {
      usage: '/resetpassword <username> <new_password> [/change]',
      description: 'Resets the password for the given username. Optionally, use the `/change` flag to require the user to change their password at the next logon.',
      example: [
        '/resetpassword johndoe newpassword123',
        '/resetpassword johndoe newpassword123 /change',
      ],
    },
    getups: {
      usage: '/getups <ups_id>',
      description: 'Gets the details of the UPS with the given ID.',
      available: 'Available UPS Identifiers: pyr (Pyrite), mkt (Makarti)',
      example: ['/getups pyr', '/getups mkt'],
    },
    getasset: {
      usage: '/getasset <asset_id>',
      description: 'Gets the details of the asset with the given ID. Available asset categories include: ' + Object.keys(categoryMapping).map(key => categoryMapping[key]).join(', ') + '.',
      example: ['/getasset PC', '/getasset notebook', '/getasset mouse', '/getasset switch', '/getasset tablet', '/getasset ht', '/getasset phone', '/getasset monitor', '/getasset sim', '/getasset license'],
    },
    addwifi: {
      usage: '/addwifi <pool> <mac> <comment> [/days <number_of_days>]',
      description: 'Adds a WiFi user with the given MAC address and comment. Optionally, specify the number of days until expiration. This command is used to manage access for users in different pools based on their roles and needs.',
      example: [
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
      description: 'Lists all available pools. The available pools are as follows:\n' +
                   '- * /staff*, * /nonstaff*, and * /management*: These pools are designated for mobile phones connected to WiFi MTI-02.\n' +
                   '- * /employeefull* and * /employeelimited*: These pools are for laptops connected to WiFi MTI-01.\n' +
                   '- * /contractor*: This pool is for laptops connected to WiFi MTI-03.',
    },
    leasereport: {
      usage: '/leasereport',
      description: 'Displays all users with a limited expiration date.',
    },
    getbitlocker: {
      usage: '/getbitlocker <hostname>',
      description: 'Retrieves BitLocker status for the specified asset ID.',
      example: ['/getbitlocker mti-nb-123'],
    },
    ticketreport: {
      usage: '/ticketreport [days] [technicianName]',
      description: 'Generates a report of tickets created in the last specified number of days. Optionally, filter the report by technician name.',
      available: 'If no days are specified, defaults to the last 7 days.',
      example: [
        '/ticketreport', // Default to last 7 days
        '/ticketreport 14', // Last 14 days
        '/ticketreport 30 peggy' // Last 30 days for technician John Doe
      ],
    },
    technician: {
      usage: '/technician <command> [parameters]',
      description: 'Comprehensive technician contact management system for IT support operations. Manage your team\'s contact information with full CRUD capabilities.',
      available: '📋 **Available Commands:**\n• **list** - Display all technicians\n• **search <query>** - Find technicians by name, phone, email, or role\n• **view <id>** - Show detailed info for specific technician\n• **add** - Add new technician with full details\n• **update** - Modify existing technician information\n• **delete** - Remove technician from database',
      example: [
        '📋 **List all technicians:**\n/technician list',
        '🔍 **Search for specific technician:**\n/technician search Peggy\n/technician search "IT Support"\n/technician search 08123',
        '👤 **View technician details:**\n/technician view 5',
        '➕ **Add new technician:**\n/technician add "Ahmad Rizki" "Ahmad Rizki (Network Admin)" "08123456789" "ahmad.rizki@company.com" "Network Administrator" "Male"',
        '✏️ **Update technician info:**\n/technician update 3 "phone" "08987654321"\n/technician update 7 "email" "new.email@company.com"\n/technician update 2 "technician" "Senior IT Support"',
        '🗑️ **Remove technician:**\n/technician delete 8'
      ],
      details: '**Real-world Usage Scenarios:**\n\n🔧 **Daily Operations:**\n• Quickly find technician contact during emergencies\n• Update phone numbers when staff get new devices\n• Add new team members with complete contact info\n• Search by role to find specialists (e.g., "Network", "Security")\n\n📱 **Search Tips:**\n• Search by partial name: "Peg" finds "Peggy"\n• Search by role: "IT Support" finds all support staff\n• Search by phone: "0812" finds numbers starting with 0812\n• Search is case-insensitive and matches partial text\n\n⚠️ **Important Notes:**\n• Use quotes for multi-word values: "John Doe"\n• Available fields for update: name, ict_name, phone, email, technician, gender\n• Each technician has a unique ID for precise operations\n• Changes are saved immediately to the database'
    },
    licenses: {
      usage: '/licenses [limit] [offset]',
      description: 'Lists all software licenses with pagination support. Shows license name, category, seat usage, and expiration status.',
      example: [
        '/licenses',
        '/licenses 10',
        '/licenses 10 0'
      ],
      details: 'Retrieves licenses from Snipe-IT asset management system. Default limit is 50 licenses per page. Use offset for pagination through large license inventories.'
    },
    getlicense: {
      usage: '/getlicense <name_or_id>',
      description: 'Gets detailed information about a specific license by name or ID.',
      example: [
        '/getlicense Microsoft Office',
        '/getlicense 123',
        '/getlicense "Adobe Creative Suite"'
      ],
      details: 'Searches for licenses by exact name match or ID. Returns comprehensive details including manufacturer, purchase information, seat allocation, and expiration dates.'
    },
    expiring: {
      usage: '/expiring [days]',
      description: 'Lists licenses expiring within specified number of days. Helps with proactive license renewal planning.',
      example: [
        '/expiring',
        '/expiring 30',
        '/expiring 90'
      ],
      details: 'Default is 30 days if not specified. Shows license name, current usage, total seats, and days until expiration. Critical for compliance and budget planning.'
    },
    licensereport: {
      usage: '/licensereport',
      description: 'Generates a comprehensive license utilization report with statistics and breakdown by category.',
      example: ['/licensereport'],
      details: 'Provides overview of total licenses, utilization rates, expiration status, and category breakdown. Essential for license management and compliance auditing.'
    },
  };

  // Check if the command exists in the commandDetails object
  if (commandDetails[command]) {
    const details = commandDetails[command];
    let helpText = `*Usage:* ${details.usage}\n*Description:* ${details.description}`;
    if (details.details) {
      helpText += `\n*Details:* ${details.details}`;
    }
    if (details.available) {
      helpText += `\n*Available:* ${details.available}`;
    }
    if (details.example) {
      helpText += `\n*Example(s):*\n${details.example.join('\n')}`;
    }
    return helpText;
  } else {
    return 'Command not ffound. Please check the command and try again.';
  }
}


async function handleFindUser(...args) {
  console.log('--- handleFindUser start ---');
  let sock = null;
  let from = null;
  let input;

  // 1) Parse args
  if (args.length === 1) {
    input = args[0];
    console.log('Called directly with input:', input);
  } else if (args.length === 3) {
    [sock, from, input] = args;
    console.log('Called with sock/from/input:', { from, input });
  } else {
    console.error('Invalid number of arguments:', args.length);
    throw new Error("Invalid number of arguments");
  }

  // 2) Department map
  const departmentMapping = {
    ap: "Acid", cp: "Chloride", ccp: "Copper",
    ea: "External", hr: "Human", ohs: "Occupational",
    pyrite: "Pyrite", ts: "Technical"
  };

  // 3) Build searchCriteria + detect /photo flag
  const searchCriteria = [];
  let includePhoto = false;
  console.log('Building search criteria from input...');

  if (typeof input === 'object' && input !== null) {
    console.log('Input is an object:', input);
    if (input.name) {
      const n = input.name.toLowerCase();
      console.log(' → Adding CN filter for name:', n);
      searchCriteria.push(`(cn=*${n}*)`);
    }
    if (input.jobTitle) {
      const t = input.jobTitle.toLowerCase();
      console.log(' → Adding title filter:', t);
      searchCriteria.push(`(title=*${t}*)`);
    }
    if (input.department) {
      const deptRaw = input.department.toLowerCase();
      const dept = departmentMapping[deptRaw] || input.department;
      console.log(' → Adding department filter:', dept);
      searchCriteria.push(`(department=*${dept.toLowerCase()}*)`);
    }
  }
  else if (typeof input === 'string' && input.startsWith('/finduser')) {
    console.log('Input is a /finduser command:', input);
    const parts = input.trim().split(/\s+/).slice(1);

    // detect and strip "/photo"
    const photoIdx = parts.findIndex(p => p.toLowerCase() === '/photo');
    includePhoto = photoIdx !== -1;
    if (includePhoto) {
      console.log(' → /photo flag detected');
      parts.splice(photoIdx, 1);
    }

    if (!parts.length) {
      const errMsg = 'Error: No name provided with /finduser command';
      console.error(errMsg);
      if (sock && from) await sock.sendMessage(from, { text: errMsg });
      return errMsg;
    }

    const nameQuery = parts.join(' ').toLowerCase();
    console.log(' → Adding CN filter for command name:', nameQuery);
    searchCriteria.push(`(cn=*${nameQuery}*)`);
  }
  else if (typeof input === 'string') {
    const q = input.toLowerCase();
    console.log('Input is a plain string, adding CN filter:', q);
    searchCriteria.push(`(cn=*${q}*)`);
  }
  else {
    console.warn('Unrecognized input type, fallback to string:', input);
    const q = String(input).toLowerCase();
    searchCriteria.push(`(cn=*${q}*)`);
  }

  if (!searchCriteria.length) {
    const errMsg = 'Error: No search criteria provided';
    console.error(errMsg);
    if (sock && from) await sock.sendMessage(from, { text: errMsg });
    return errMsg;
  }

  // 4) Construct balanced LDAP filter
  const ldapQuery = `(&${searchCriteria.join('')})`;
  console.log('Constructed LDAP query:', ldapQuery);

  // 5) Perform LDAP lookup via callback
  return new Promise((resolve) => {
    console.log('Querying LDAP for users...');
    admti.findUsers(ldapQuery, false, async (err, users) => {
      if (err) {
        const errorMsg = `Error finding user: ${err.message}`;
        console.error(errorMsg);
        if (sock && from) await sock.sendMessage(from, { text: errorMsg });
        return resolve(errorMsg);
      }

      if (!users || !users.length) {
        const notFound = 'User not found.';
        console.log(notFound);
        if (sock && from) await sock.sendMessage(from, { text: notFound });
        return resolve(notFound);
      }

      // 6) For each user: build caption, optionally fetch/send photo
      for (const user of users) {
        console.log('Processing user:', user.displayName);

        const lastSet   = convertFileTimeToDateString(user.pwdLastSet);
        const expires   = convertFileTimeToDateString(user['msDS-UserPasswordExpiryTimeComputed']);
        const expiryMsg = user['msDS-UserPasswordExpiryTimeComputed'] && !isExceptionallyLongDate(expires)
          ? `Password Expired on: ${expires}`
          : "Password never expires";

        // Initialize photo variables first
        let photoBuffer = null;
        let photoStatus = '';
        // Handle photo processing if requested
        if (includePhoto && user.employeeID) {
          console.log(`📷 [FindUser] Fetching photo for EmployeeID ${user.employeeID}…`);
          try {
            photoBuffer = await getUserPhotoFromDB(user.employeeID);
            if (photoBuffer) {
              console.log(`✅ [FindUser] Photo buffer received, size: ${photoBuffer.length} bytes`);
              
              // Validate photo data integrity
              const validation = validatePhotoData(photoBuffer);
              if (validation.valid) {
                console.log(`✅ [FindUser] Photo validation passed - Format: ${validation.format}, Size: ${validation.size} bytes`);
                photoStatus = ' 📷';
              } else {
                console.log(`❌ [FindUser] Photo validation failed: ${validation.reason}`);
                photoBuffer = null; // Don't send invalid photo
                photoStatus = ' (Invalid photo data)';
              }
            } else {
              console.log(`❌ [FindUser] No photo found in DB for EmployeeID: ${user.employeeID}`);
              photoStatus = ' (No photo available)';
            }
          } catch (dbErr) {
            console.error(`❌ [FindUser] DB lookup error for ${user.employeeID}:`, dbErr.message);
            photoStatus = ' (Photo retrieval failed)';
          }
        } else if (includePhoto && !user.employeeID) {
          console.log(`⚠️ [FindUser] Photo requested but no EmployeeID found for user: ${user.displayName}`);
          photoStatus = ' (No Employee ID)';
        }

        // Build caption after photo processing
        const caption =
          `*${user.displayName}* [MTI]${photoStatus}\n` +
          `📧 ${user.userPrincipalName}\n` +
          `🏷️ ${user.title}\n` +
          `🏢 ${user.department}\n` +
          `📱 ${user.mobile || 'Not available'}\n` +
          (user.employeeID ? `🆔 ${user.employeeID}\n` : '') +
          `🔒 Last Pass Change: ${lastSet}\n` +
          `⏳ ${expiryMsg}`;

        console.log('Built caption:', caption.replace(/\n/g, ' | '));

        if (sock && from) {
          if (includePhoto && photoBuffer) {
            console.log('Sending image + caption to', from);
            await sock.sendMessage(from, { image: photoBuffer, caption });
          } else {
            console.log('Sending text-only caption to', from);
            await sock.sendMessage(from, { text: caption });
          }
        }
      }

      console.log('--- handleFindUser end: success ---');
      resolve(`✓ Sent user info${includePhoto ? ' (with photo)' : ''}`);
    });
  });
}


//Last Known Good 19/05/2025

// async function handleFindUser(...args) {
//   let sock = null;
//   let from = null;
//   let input;

//   // Check the number of arguments and assign them appropriately
//   if (args.length === 1) {
//       input = args[0]; // Direct call with either name, jobTitle, department, etc.
//   } else if (args.length === 3) {
//       sock = args[0];
//       from = args[1];
//       input = args[2];
//   } else {
//       throw new Error("Invalid number of arguments");
//   }

//   // Department alias mapping
//   const departmentMapping = {
//     "ap": "Acid",
//     "cp": "Chloride",
//     "ccp": "Copper",
//     "ea": "External",
//     "hr": "Human",
//     "ohs": "Occupational",
//     "pyrite": "Pyrite",
//     "ts": "Technical"
//   };

//   let searchCriteria = [];

//   console.log("Input received:", input);

//   if (typeof input === 'object' && input !== null) {
//       if ('name' in input) { // Changed from 'username' to 'name'
//           // Interpret 'name' as parts of the display name (CN)
//           const normalizedName = input.name.toLowerCase();
//           console.log("Searching by display name (CN):", normalizedName);
//           searchCriteria.push(`cn=*${normalizedName}*`); // Search CN with flexible partial matching
//       }
//       if ('jobTitle' in input) {
//           const normalizedJobTitle = input.jobTitle.toLowerCase();
//           console.log("Searching by job title:", normalizedJobTitle);
//           searchCriteria.push(`title=*${normalizedJobTitle}*`);
//       }
//       if ('department' in input) {
//           const department = departmentMapping[input.department.toLowerCase()] || input.department;
//           const normalizedDepartment = department.toLowerCase();
//           console.log("Searching by department:", normalizedDepartment);
//           searchCriteria.push(`department=*${normalizedDepartment}*`);
//       }
//   } else if (typeof input === 'string' && input.startsWith('/finduser')) {
//     const commandParts = input.split(' ');

//     // Check if commandParts has more than 1 part to avoid accessing undefined
//     if (commandParts.length > 1) {
//         const normalizedName = commandParts.slice(1).join(' ').toLowerCase(); // Use entire input after '/finduser'
//         console.log("Searching by command input name:", normalizedName);
//         searchCriteria.push(`cn=*${normalizedName}*`);
//     } else {
//         // If the name is missing, log an error and send a message if applicable
//         const errorMessage = 'Error: No name provided with /finduser command';
//         console.error(errorMessage);
//         if (sock && from) {
//             await sock.sendMessage(from, { text: errorMessage });
//         }
//         return errorMessage;
//     }
//   } else {
//       const normalizedInput = input.toLowerCase();
//       console.log("Searching by direct input:", normalizedInput);
//       searchCriteria.push(`cn=*${normalizedInput}*`);
//   }

//   if (searchCriteria.length === 0) {
//       const errorMessage = 'Error: No search criteria provided';
//       console.error(errorMessage);
//       if (sock && from) {
//           await sock.sendMessage(from, { text: errorMessage });
//       }
//       return errorMessage;
//   }

//   // Construct the query using LDAP syntax for AND
//   const ldapQuery = `(&${searchCriteria.map(crit => `(${crit})`).join('')})`;
//   console.log("Constructed LDAP query:", ldapQuery);

//   try {
//       return new Promise((resolve) => {
//           admti.findUsers(ldapQuery, false, async (err, users) => {
//               if (err) {
//                   console.error('Error finding user:', err);
//                   const errorMsg = `Error finding user: ${err.message}`;
//                   if (sock && from) {
//                       await sock.sendMessage(from, { text: errorMsg });
//                   }
//                   resolve(errorMsg);
//               } else if (!users || users.length === 0) {
//                   const notFoundMsg = 'User not found.';
//                   console.log(notFoundMsg);
//                   if (sock && from) {
//                       await sock.sendMessage(from, { text: notFoundMsg });
//                   }
//                   resolve(notFoundMsg);
//               } else {
//                   let userMessages = [];
//                     for (const user of users) {
//                       console.log("Processing user:", user.displayName);
//                       const dateString = convertFileTimeToDateString(user.pwdLastSet);
//                       const expiredDateString = convertFileTimeToDateString(user['msDS-UserPasswordExpiryTimeComputed']);
//                       let message = `User Information for ${user.displayName} [MTI]: \n`;
//                       message += `- Email: ${user.userPrincipalName}\n`;
//                       message += `- Title: ${user.title}\n`;
//                       message += `- Department: ${user.department}\n`;
//                       message += `- Mobile Number: ${user.mobile ? user.mobile : 'Not available'}\n`;
//                       if (user.employeeID) {
//                         message += `- Employee ID: ${user.employeeID}\n`;
//                       }
//                       message += `- Last Password Mod: ${dateString}\n`;
//                       if (user['msDS-UserPasswordExpiryTimeComputed'] && !isExceptionallyLongDate(expiredDateString)) {
//                         message += `- Password Expired on: ${expiredDateString}\n`;
//                       } else {
//                         message += `- Password Expired on: Never expired\n`;
//                       }
//                       console.log("User message constructed:", message);
//                       userMessages.push(message);
//                       if (sock && from) {
//                         await sock.sendMessage(from, { text: message });
//                       }
//                     }
//                   resolve(userMessages.join("\n\n"));
//               }
//           });
//       });
//   } catch (err) {
//       console.error('Error finding user:', err);
//       const errorMsg = `Error finding user: ${err.message}`;
//       if (sock && from) {
//           await sock.sendMessage(from, { text: errorMsg });
//       }
//       return errorMsg;
//   }
// }




const handleMessage = async (sock, msg) => {
  // Ensure the message exists
  if (!msg.message) return;

  const from = msg.key.remoteJid;
  const text = extractMessageContent(msg) || '';
  const hasDocument = msg.message.documentMessage !== undefined;
  const hasImage = !!(msg.message.imageMessage && msg.message.imageMessage.url);
  //const hasImage = msg.message.imageMessage !== undefined;
  const isFromMe = msg.key.fromMe || false;
  const isGroupMessage = from.endsWith('@g.us');
  const pushName = msg.pushName || 'Unknown User';

  // If the message is a command, delegate to handleChatBot and exit
  if (text.startsWith('/')) {
    await handleChatBot(sock, from, text, isFromMe, hasDocument, hasImage, msg);
    return;
  }

  /*
   * Decide if we should process the message:
   *  - For messages not from me: process if it's a direct message
   *    or a group message that's tagged.
   *  - For messages from me: process only if the text starts with "ai".
   */
  console.log('🔍 MESSAGE PROCESSING CHECK:');
  console.log('  - From:', from);
  console.log('  - IsFromMe:', isFromMe);
  console.log('  - IsGroupMessage:', isGroupMessage);
  console.log('  - Message text:', text);
  
  let isTaggedResult = false;
  if (isGroupMessage && !isFromMe) {
    isTaggedResult = isTagged(text);
    console.log('  - isTagged result:', isTaggedResult);
  }
  
  const shouldProcess =
    (!isFromMe && (!isGroupMessage || isTaggedResult)) ||
    (isFromMe && text.toLowerCase().startsWith('ai'));

  console.log('  - Should process:', shouldProcess);
  
  if (!shouldProcess) {
    console.log('❌ Message not processed - conditions not met');
    return;
  }
  
  console.log('✅ Message will be processed');

  console.log('Handling assistant message for:', from);
  // Choose the correct handler based on whether the message includes an image
  if (hasImage) {
    console.log('Handling image message for:', hasImage);
    await handleImageMessage(sock, msg, from);
  } else {
    await handleConversationMessage(sock, msg, text, from, pushName);
  }
};







const handleConversationMessage = async (sock, msg, text, from, pushName) => {
  try {
      const quotedMessage = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;

      let combinedMessage = text; // Start with the user's message text
      let quotedText = '';
      let quotedImageAnalysis = '';

      if (quotedMessage) {
          console.log('Quoted message detected:', quotedMessage);

          // Extract text from the quoted message
          try {
              quotedText = quotedMessage.conversation || quotedMessage.extendedTextMessage?.text || '';
              if (quotedText) {
                  console.log('Quoted text:', quotedText);
              } else {
                  console.log('No quoted text found.');
              }
          } catch (error) {
              console.error('Error extracting quoted text:', error);
              quotedText = 'Failed to extract quoted text.';
          }

          // Check if the quoted message contains an image
          if (quotedMessage.imageMessage) {
              try {
                  console.log('Quoted image message detected.');

                  // Download image buffer
                  const quotedImageBuffer = await downloadMediaMessage(
                      { message: { imageMessage: quotedMessage.imageMessage } },
                      'buffer',
                      {},
                      { logger: console, reuploadRequest: sock.updateMediaMessage }
                  );

                  // Convert image to Base64
                  const base64QuotedImage = encodeImage(quotedImageBuffer);
                  console.log('Quoted image has been downloaded and encoded to base64.');

                  // Analyze the image
                  quotedImageAnalysis = await gatherImageInformation(base64QuotedImage, 'Analyze this quoted image.');
                  console.log('Quoted image analysis result:', quotedImageAnalysis);
              } catch (error) {
                  console.error('Error processing quoted image:', error);
                  quotedImageAnalysis = 'Failed to analyze quoted image.';
              }
          }

          // Build the combined message with quoted content
          combinedMessage = `${quotedText ? `Quoted Text: ${quotedText}\n` : ''}${
              quotedImageAnalysis ? `Quoted Image Analysis: ${quotedImageAnalysis}\n` : ''
          }User: ${text}`;
      }

      console.log('Combined message for processing:', combinedMessage);

      // Pass the combined message to handleAssistantMessage
      try {
          await handleAssistantMessage(sock, { ...msg, message: { conversation: combinedMessage } }, pushName);
      } catch (error) {
          console.error('Error handling assistant message:', error);
      }
  } catch (error) {
      console.error('Unexpected error in handleConversationMessage:', error);
  }
};



// const handleConversationMessage = async (sock, msg, text, from, pushName) => {
//   const quotedMessage = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;
//   if (quotedMessage?.conversation) {
//       // Extract the quoted message content
//       const quotedText = quotedMessage.conversation;
//       console.log(`Quoted message: ${quotedText}`);
      
//       // Combine quoted message with the new message
//       const combinedMessage = `${quotedText}\n\nUser: ${text}`;
//       console.log(`Combined message for processing: ${combinedMessage}`);
      
//       // Process the combined message as needed
//       await handleAssistantMessage(sock, { ...msg, message: { conversation: combinedMessage } }, pushName);
//   } else {
//       // If not a quoted message, handle the text normally
//       await handleAssistantMessage(sock, msg, pushName);
//   }
// };


const handleChatBot = async (sock, from, text, isFromMe, hasDocument, hasImage, message) => {
  const commandDetails = {
    finduser: '*Usage:* /finduser <username>\n*Description:* Finds the user with the given username.\n*Example:* /finduser peggy',
    resetpassword: '*Usage:* /resetpassword <username>\n*Description:* Resets the password for the given username.',
    getups: '*Usage:* /getups <ups_id>\n*Description:* Gets the details of the UPS with the given ID or hostname.\n*Available UPS Identifiers:* pyr (Pyrite), mkt (Makarti)\n*Example:* /getups pyr',
    getasset: '*Usage:* /getasset <asset_id>\n*Description:* Gets the details of the asset with the given ID.',
    addwifi: '*Usage:* /addwifi <pool> <mac> <comment> [/days <number_of_days>]\n*Description:* Adds a WiFi user with the given MAC address and comment. Optionally, specify the number of days until expiration.\n*Example:* /addwifi /staff 00:1A:2B:3C:4D:5E John Doe - Staff Member\n*Example with expiration:* /addwifi /staff 00:1A:2B:3C:4D:5E /days 7 John Doe - Temporary Staff',
    checkwifi: '*Usage:* /checkwifi <mac>\n*Description:* Checks the status of the WiFi user with the given MAC address.',
    movewifi: '*Usage:* /movewifi <old_pool> <new_pool> <mac>\n*Description:* Moves the WiFi user with the given MAC address from the old pool to the new pool.',
    newuser: '*Usage:* /newuser <username> <email>\n*Description:* Creates a new user with the given username and email.',
    pools: '*Usage:* /pools\n*Description:* Lists all available pools.',
    leasereport: '*Usage:* /leasereport\n*Description:* Displays all users with a limited expiration date.',
    getbitlocker: '*Usage:* /getbitlocker <hostname>\n*Description:* Retrieves BitLocker status for the specified asset ID.\n*Example:* /getbitlocker mti-nb-123',
    licenses: '*Usage:* /licenses [limit] [offset]\n*Description:* Lists all software licenses with pagination.\n*Example:* /licenses 10 0',
    getlicense: '*Usage:* /getlicense <name_or_id>\n*Description:* Gets detailed information about a specific license.\n*Example:* /getlicense Microsoft Office',
    expiring: '*Usage:* /expiring [days]\n*Description:* Lists licenses expiring within specified days (default: 30).\n*Example:* /expiring 60',
    licensereport: '*Usage:* /licensereport\n*Description:* Generates a comprehensive license utilization report.',
    ack: '*Usage:* /ack [alert_id] or reply to alert message with /ack\n*Description:* Acknowledges a Veeam alert. Can be used by replying to an alert message or providing the alert ID directly.\n*Example:* /ack db95c987-a404-45b0-ba2c-c406f483e5b9 or reply to alert with /ack',
  };

  if (text === '/hai') {
      const response = { text: 'hello @6285712612218', mentions:['6285712612218@s.whatsapp.net'] };
      try {
          await sock.sendMessage(from, response);
          console.log('Reply sent:', response);
      } catch (error) {
          console.error('Error sending reply:', error);
      }
  }
  // List all available commands
  else if (text.startsWith('/help')) {
      const parts = text.split(' ');
      if (parts.length > 1) {
          const specificCommand = parts[1].toLowerCase(); // Convert command to lowercase
          const commandDetail = await getCommandHelp(specificCommand); // Use getCommandHelp to get the details

          if (commandDetail !== 'Command not found. Please check the command and try again.') {
              try {
                  await sock.sendMessage(from, { text: commandDetail });
                  console.log(`Detailed help for ${specificCommand} sent:`, commandDetail);
              } catch (error) {
                  console.error(`Error sending detailed help for ${specificCommand}:`, error);
              }
          } else {
              try {
                  await sock.sendMessage(from, { text: '*Unknown command.* Use /help to see the list of available commands.' });
                  console.log(`Unknown command help requested: ${specificCommand}`);
              } catch (error) {
                  console.error('Error sending unknown command message:', error);
              }
          }
      } else {
          const commands = `*Available Commands:*\n`
              + `*User Commands:*\n`
              + `- /finduser\n`
              + `- /resetpassword\n`
              + `- /newuser\n`
              + `\n*WiFi Commands:*\n`
              + `- /addwifi\n`
              + `- /checkwifi\n`
              + `- /movewifi\n`
              + `- /pools\n`
              + `- /leasereport\n` // Moved leasereport to WiFi Commands
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
              + `- /ticketreport\n` // Added ticket report command
              + `\n*Alert Commands:*\n`
              + `- /ack\n` // Added alert acknowledgement command
              + `\n*To get detailed help for a specific command, use:*\n`
              + `- /help <command>\n\n`
              + `*Example:*\n`
              + `- /help finduser`;
          try {
              await sock.sendMessage(from, { text: commands });
              console.log('Command list sent:', commands);
          } catch (error) {
              console.error('Error sending command list:', error);
          }
      }
  } else if (text.startsWith('/resetpassword')) {
      const parts = text.split(/ |\u00A0|'/);
      const username = parts[1];
      const newPassword = parts[2];
      
      // Validate required parameters
      if (!username || !newPassword) {
        await sock.sendMessage(from, { 
          text: `❌ Invalid command format. Usage: /resetpassword <username> <newPassword> [/change]\n\nExample: /resetpassword john.doe NewPass123 /change` 
        });
        return;
      }
      
      const changePasswordAtNextLogon = parts.length > 3 && parts[3] === '/change';

      // Extract the phone number of the user who sent the message
      const phoneNumberMatch = from.match(/(\d+)@s\.whatsapp\.net/);
      console.log(phoneNumberMatch);

      if (!phoneNumberMatch) {
          // Respond with an error message for invalid phone number format
          sock.sendMessage(from, { text: 'Invalid phone number format.' });
          return;
      }

      const phoneNumber = phoneNumberMatch[1]; // Extracted phone number
      console.log(phoneNumber);

      // Check if the requesting phone number is in the list of allowed numbers
      if (!allowedPhoneNumbers.includes(phoneNumber)) {
          // Respond with an "Access denied" message for unauthorized access
          sock.sendMessage(from, { text: 'Access denied. You are not authorized to perform this action.' });
          return;
      }

      resetPassword(username, newPassword, changePasswordAtNextLogon)
          .then((result) => {
              if (!result.success) {
                  sock.sendMessage(from, { text: `Error resetting password for ${username}: ${result.error}` });
              } else {
                  console.log(`Password reset for ${username} successful`);
                  sock.sendMessage(from, { text: `Password reset for ${username} successful` });
              }
          })
          .catch((error) => {
              console.error(`Error resetting password: ${error.message}`);
              sock.sendMessage(from, { text: `Error resetting password: ${error.message}` });
          });
  }

  else if (text.startsWith('/getbitlocker')) {
    const hostname = text.split(/\s+/)[1];
    
    // Validate required parameter
    if (!hostname) {
      await sock.sendMessage(from, { 
        text: `❌ Invalid command format. Usage: /getbitlocker <hostname>\n\nExample: /getbitlocker MTI-NB-177` 
      });
      return;
    }

    getBitLockerInfo(hostname)
      .then(result => {
        if (!result.success) {
          return sock.sendMessage(from, {
            text: `*Error:* ${result.error}`
          });
        }
  
        const { hostname: host, keys } = result.data;
        const lines = [`*Hostname:* ${host}`, ''];
  
        keys.forEach((k, idx) => {
          // Extract timestamp portion from partitionId: "YYYY-MM-DDThh:mm:ss"
          const match = k.partitionId.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/);
          let formattedDate = 'Invalid Date';
          if (match) {
            const [ , Y, M, D, h, m, s ] = match;
            const dt = new Date(
              +Y, +M - 1, +D,
              +h, +m, +s
            );
            formattedDate = dt.toLocaleString('en-GB', {
              timeZone: 'Asia/Jakarta',
              day:    '2-digit',
              month:  'short',
              year:   'numeric',
              hour:   '2-digit',
              minute: '2-digit',
              second: '2-digit'
            });
          }
  
          // Extract GUID part
          const guid = (k.partitionId.split('{')[1] || '').replace('}', '');
  
          lines.push(
            `*Password ID ${idx+1}:* ${guid}`,
            `*Date:*          ${formattedDate}`,
            `*Recovery Key ${idx+1}:* ${k.password}`,
            '' // blank line
          );
        });
  
        // Remove trailing blank line
        if (lines[lines.length - 1] === '') lines.pop();
  
        const message = lines.join('\n');
        sock.sendMessage(from, { text: message });
      })
      .catch(err => {
        console.error('BitLocker lookup error:', err);
        sock.sendMessage(from, {
          text: `*Error retrieving BitLocker info:* ${err.message}`
        });
      });
  }
  
  
  

  
  //Find user in AD
  else if (text.startsWith('/finduser')) {
      await handleFindUser(sock, from, text);
  }
  //Get UPS status from Zabbix
  else if (text.startsWith('/getups')) {
      const params = text.split(' ');
      if (params.length < 2) {
          await sock.sendMessage(from, { text: 'Error: Hostname not provided' });
          return;
      }

      const identifier = params[1];
      const hostName = hostnameMapping[identifier] || identifier; // Map identifier to hostname, fallback to identifier if not mapped

      const itemKeys = [
          'system.model[upsBasicIdentModel]',
          'system.location[sysLocation.0]',
          'battery.runtime_remaining[upsAdvBatteryRunTimeRemaining]',
          'input.voltage[upsHighPrecInputLineVoltage]',
          'input.frequency[upsHighPrecInputFrequency]',
          'output.voltage[upsHighPrecOutputVoltage]',
          'output.current[upsHighPrecOutputCurrent]',
          'battery.capacity[upsHighPrecBatteryCapacity]',
      ];

      try {
          const authToken = await loginToZabbix();
          const upsInfo = await getUPSInfoForHost(authToken, hostName, itemKeys);

          if (!upsInfo || Object.keys(upsInfo).length === 0) {
              await sock.sendMessage(from, { text: `No UPS information found for host: ${hostName}` });
              return;
          }

          let response = `UPS Information for ${hostName}:\n`;
          for (const key in upsInfo) {
              upsInfo[key] = roundToDecimal(upsInfo[key]);
              if (key === 'Battery runtime remaining') {
                  upsInfo[key] = formatTime(upsInfo[key]);
              }
              const value = addUnits(key, upsInfo[key]);
              response += `- ${key}: ${value}\n`;
          }
          await sock.sendMessage(from, { text: response });
      } catch (error) {
          console.error('Error retrieving UPS information:', error);
          await sock.sendMessage(from, { text: `Error retrieving UPS information: ${error.message}` });
      }
  }
  //Get asset from Snipe IT
  else if (text.startsWith('/getasset')) {
      await handleGetAsset(sock, from, text);
  }
  // else if (text.startsWith('/addwifi')) {
  //     const parts = text.split(/ |\u00A0|'/);
  //     const poolName = parts[1];
  //     const macAddress = parts[2].replace(/:/g, ''); // Remove colons from MAC address

  //     let daysUntilExpiration = null;
  //     let comment = '';
  //     let isTestMode = false;

  //     // Check if the command contains `/days` keyword
  //     const daysIndex = parts.indexOf('/days');
  //     if (daysIndex !== -1 && parts[daysIndex + 1] && !isNaN(parts[daysIndex + 1])) {
  //         daysUntilExpiration = parts[daysIndex + 1];
  //         comment = parts.slice(3, daysIndex).concat(parts.slice(daysIndex + 2)).join(' '); // Comment is everything except the `/days` part and the number of days
  //         isTestMode = comment.includes('/test'); // Check for `/test` flag
  //         if (isTestMode) {
  //             comment = comment.replace('/test', '').trim(); // Remove `/test` flag from the comment
  //         }
  //     } else {
  //         comment = parts.slice(3).join(' '); // Comment is everything from the 4th part onwards
  //     }

  //     try {
  //         const conn = await connectRouterOS();
  //         const result = await addWifiUser(conn, poolName, macAddress, comment, daysUntilExpiration, isTestMode);
  //         if (result.success) {
  //             await sock.sendMessage(from, { text: result.message });
  //         } else {
  //             await sock.sendMessage(from, { text: `Error adding WiFi user: ${result.error}` });
  //         }
  //         conn.close();
  //     } catch (error) {
  //         console.error('Error adding WiFi user:', error);
  //         await sock.sendMessage(from, { text: `Error adding WiFi user: ${error.message}` });
  //     }
  // }

  else if (text.startsWith('/addwifi')) {
    // Extract the phone number of the user who sent the message
    const phoneNumberMatch = from.match(/(\d+)@s\.whatsapp\.net/);
    
    if (!phoneNumberMatch) {
      await sock.sendMessage(from, { text: 'Invalid phone number format.' });
      return;
    }
    
    const phoneNumber = phoneNumberMatch[1]; // Extracted phone number
    
    // Check if the requesting phone number is in the list of allowed numbers
    if (!allowedPhoneNumbers.includes(phoneNumber)) {
      await sock.sendMessage(from, { text: '🚫 **ACCESS DENIED** 🚫\n\n❌ You are NOT authorized to use this WiFi management feature!\n\n📞 Please contact the ICT Team immediately for access requests.\n\n⚠️ This incident may be logged for security purposes.' });
      return;
    }
    
    const parts = text.split(/ |\u00A0|'/);
    const poolName = parts[1];
    
    // Validate required parameters
    if (!poolName || !parts[2]) {
      await sock.sendMessage(from, { 
        text: `❌ Invalid command format. Usage: /addwifi <poolName> <macAddress> [comment] [/days <number>] [/test]\n\nExample: /addwifi guest 00:11:22:33:44:55 User device /days 7` 
      });
      return;
    }
    
    const macAddress = parts[2].replace(/:/g, ''); // Remove colons from MAC address
  
    let daysUntilExpiration = null;
    let comment = '';
    let isTestMode = false;
  
    // Check if the command contains `/days` keyword
    const daysIndex = parts.indexOf('/days');
    if (daysIndex !== -1 && parts[daysIndex + 1] && !isNaN(parts[daysIndex + 1])) {
      daysUntilExpiration = parts[daysIndex + 1];
      comment = parts.slice(3, daysIndex).concat(parts.slice(daysIndex + 2)).join(' ').trim(); // Clean up comment
      isTestMode = comment.includes('/test'); // Check for `/test` flag
      if (isTestMode) {
        comment = comment.replace('/test', '').trim(); // Remove `/test` flag from the comment
      }
    } else {
      comment = parts.slice(3).join(' ').trim(); // Clean up comment for non-test mode
    }
  
    try {
      // Call the refactored addWifiUser function with an object as parameter
      const result = await addWifiUser({
        poolName,
        macAddress,
        comment,
        daysUntilExpiration,
        isTestMode
      });
  
      if (result.success) {
        await sock.sendMessage(from, { text: result.message });
      } else {
        await sock.sendMessage(from, { text: `Error adding WiFi user: ${result.error}` });
      }
    } catch (error) {
      console.error('Error adding WiFi user:', error);
      await sock.sendMessage(from, { text: `Error adding WiFi user: ${error.message}` });
    }
  }
  

  else if (text.startsWith('/pools')) {
      const pools = Object.keys(poolMapping).join(', ');
      await sock.sendMessage(from, { text: `Available pools: ${pools}` });
  }
  else if (text.startsWith('/leasereport')) {
      await handleLeaseReport(from);
  }
  else if (text.startsWith('/checkwifi')) {
    const parts = text.split(/ |\u00A0|'/);
  
    if (parts.length < 2) {
      await sock.sendMessage(from, { text: 'Error: Please provide a MAC address. Example: /checkwifi 00:11:22:33:44:55' });
      return;
    }
  
    let macAddress = parts[1].replace(/[:\-]/g, ''); // Remove colons from MAC address
  
    // Call checkWifiStatus and get the result
    const result = await checkWifiStatus(macAddress);
  
    // Send the result message back to the user
    await sock.sendMessage(from, { text: result.message });
  }
  

  // else if (text.startsWith('/checkwifi')) {
  //     const parts = text.split(/ |\u00A0|'/);
  //     if (parts.length < 2) {
  //         await sock.sendMessage(from, { text: 'Error: Please provide a MAC address.' });
  //         return;
  //     }

  //     let macAddress = parts[1].replace(/[:\-]/g, ''); // Remove colons from MAC address
  //     if (!macAddress.match(/^[0-9A-Fa-f]{12}$/)) {
  //         await sock.sendMessage(from, { text: 'Error: Invalid MAC address format.' });
  //         return;
  //     }
  //     macAddress = macAddress.match(/.{1,2}/g).join(':').toUpperCase(); // Add colons and convert to uppercase

  //     try {
  //         const conn = await connectRouterOS();
  //         const result = await checkWifiStatus(conn, macAddress);
  //         if (result.success) {
  //             await sock.sendMessage(from, { text: result.message });
  //         } else {
  //             await sock.sendMessage(from, { text: `Error checking WiFi status: ${result.error}` });
  //         }
  //         conn.close();
  //     } catch (error) {
  //         console.error('Error checking WiFi status:', error);
  //         await sock.sendMessage(from, { text: `Error checking WiFi status: ${error.message}` });
  //     }
  // }
  else if (text.startsWith('/newuser')) {
      if (!hasDocument) {
          await sock.sendMessage(from, { text: 'Please attach the document.' });
      } else if (!isFromMe) {
          await handleNewUserMessage(sock, message, from);
      }
  }
  else if (text.startsWith('/readimage')) {
      console.log('OKE');
      if (!isFromMe && !isGroupMessage) {
          await handleImageMessage(sock, message, from);
      } else if (isTagged(text)) {
          console.log('🔍 /readimage - isTagged check passed for:', from);
          console.log('  - Message text:', text);
          console.log('Handling tagged assistant message for:', from);
          await handleImageMessage(sock, message, from);
      } else {
          console.log('Message not handled due to restrictions or conditions.');
      }
  }
  else if (text.startsWith('/alarm')) {
    await handleAlarm(sock, from, text);
  }
  else if (text.startsWith('/ticketreport')) {
    const parts = text.split(/ |\u00A0|'/);
    console.log('Parts:', parts); // This will show you what the command splits into

    // Check if the second part exists and is a valid number
    const days = parts.length > 1 && !isNaN(parseInt(parts[1], 10)) ? parseInt(parts[1], 10) : 7; 
    // Check if the third part exists for technicianName
    const technicianName = parts.length > 2 ? parts[2] : null; 
    console.log(`Generating ticket report for ${days} days for technician: ${technicianName || 'all technicians'}...`); // Log the number of days and technician name

    try {
        const reportText = await ticket_report(days, technicianName); // Pass the days and technicianName parameters to the ticket_report function
        await sock.sendMessage(from, { text: reportText });
        console.log('Ticket report sent successfully.');
    } catch (error) {
        console.error('Error generating ticket report:', error);
        await sock.sendMessage(from, { text: `Error generating ticket report: ${error.message}` });
    }
  }
  else if (text.startsWith('/technician')) {
    const parts = text.split(' ');
    const command = parts[1];
    
    try {
        switch (command) {
            case 'list':
                const allTechnicians = getAllTechnicians();
                if (allTechnicians.success) {
                    const displayText = `*📋 All Technicians*\n\n${formatTechniciansDisplay(allTechnicians.data)}`;
                    await sock.sendMessage(from, { text: displayText });
                } else {
                    await sock.sendMessage(from, { text: 'Error retrieving technicians.' });
                }
                break;
                
            case 'search':
                if (parts.length < 3) {
                    await sock.sendMessage(from, { text: 'Usage: /technician search <query>' });
                    return;
                }
                const searchQuery = parts.slice(2).join(' ');
                const searchResults = searchTechnicians(searchQuery);
                if (searchResults.success) {
                    const displayText = searchResults.data.length > 0 
                        ? `*🔍 Search Results for "${searchQuery}"*\n\n${formatTechniciansDisplay(searchResults.data)}`
                        : `No technicians found matching "${searchQuery}".`;
                    await sock.sendMessage(from, { text: displayText });
                } else {
                    await sock.sendMessage(from, { text: 'Error searching technicians.' });
                }
                break;
                
            case 'view':
                if (parts.length < 3) {
                    await sock.sendMessage(from, { text: 'Usage: /technician view <id>' });
                    return;
                }
                const viewId = parts[2];
                const technician = getTechnicianById(viewId);
                if (technician.success) {
                    const displayText = `*👤 Technician Details*\n\n${formatTechnicianDisplay(technician.data)}`;
                    await sock.sendMessage(from, { text: displayText });
                } else {
                    await sock.sendMessage(from, { text: technician.message });
                }
                break;
                
            case 'add':
                // Format: /technician add "Name" "ICT Name" "Phone" "Email" "Role" "Gender"
                const addMatch = text.match(/\/technician add "([^"]+)" "([^"]+)" "([^"]+)" "([^"]+)" "([^"]+)" "([^"]+)"/i);
                if (!addMatch) {
                    await sock.sendMessage(from, { 
                        text: 'Usage: /technician add "Name" "ICT Name" "Phone" "Email" "Role" "Gender"\n\nExample:\n/technician add "John Doe" "John Doe (IT Support)" "08123456789" "john.doe@company.com" "IT Support" "Male"' 
                    });
                    return;
                }
                const [, name, ictName, phone, email, role, gender] = addMatch;
                const addResult = addTechnician({
                    name,
                    ict_name: ictName,
                    phone,
                    email,
                    technician: role,
                    gender
                });
                await sock.sendMessage(from, { text: addResult.message });
                break;
                
            case 'update':
                // Format: /technician update <id> "field" "value"
                const updateMatch = text.match(/\/technician update (\d+) "([^"]+)" "([^"]+)"/i);
                if (!updateMatch) {
                    await sock.sendMessage(from, { 
                        text: 'Usage: /technician update <id> "field" "value"\n\nAvailable fields: name, ict_name, phone, email, technician, gender\n\nExample:\n/technician update 1 "phone" "08123456789"' 
                    });
                    return;
                }
                const [, updateId, field, value] = updateMatch;
                const updateData = { [field]: value };
                const updateResult = updateTechnician(updateId, updateData);
                await sock.sendMessage(from, { text: updateResult.message });
                break;
                
            case 'delete':
                if (parts.length < 3) {
                    await sock.sendMessage(from, { text: 'Usage: /technician delete <id>' });
                    return;
                }
                const deleteId = parts[2];
                const deleteResult = deleteTechnician(deleteId);
                await sock.sendMessage(from, { text: deleteResult.message });
                break;
                
            case 'help':
            default:
                const helpText = `*🔧 Technician Management Commands*\n\n` +
                    `📋 */technician list* - Show all technicians\n` +
                    `🔍 */technician search <query>* - Search technicians\n` +
                    `👤 */technician view <id>* - View technician details\n` +
                    `➕ */technician add "Name" "ICT Name" "Phone" "Email" "Role" "Gender"* - Add new technician\n` +
                    `✏️ */technician update <id> "field" "value"* - Update technician\n` +
                    `🗑️ */technician delete <id>* - Delete technician\n` +
                    `❓ */help technician* - Show this help\n\n` +
                    `*Available fields for update:* name, ict_name, phone, email, technician, gender\n\n` +
                    `*Example:*\n` +
                    `/technician add "John Doe" "John Doe (IT Support)" "08123456789" "john.doe@company.com" "IT Support" "Male"`;
                await sock.sendMessage(from, { text: helpText });
                break;
        }
    } catch (error) {
        console.error('Error in technician command:', error);
        await sock.sendMessage(from, { text: `Error: ${error.message}` });
    }
  }


  // ===== LICENSE MANAGEMENT COMMANDS =====
  else if (text.startsWith('/licenses')) {
    try {
      const parts = text.split(' ');
      const limit = parts[1] && !isNaN(parts[1]) ? parseInt(parts[1]) : 20;
      
      const result = await getLicenses({ limit });
      
      if (!result.success) {
        await sock.sendMessage(from, { text: `❌ Error fetching licenses: ${result.error}` });
        return;
      }
      
      if (result.licenses.length === 0) {
        await sock.sendMessage(from, { text: '📄 No licenses found in Snipe-IT.' });
        return;
      }
      
      let response = `*📋 Licenses (${result.total} total, showing ${result.licenses.length})*\n\n`;
      
      result.licenses.forEach((license, index) => {
        const name = license.name || 'Unnamed License';
        const category = license.category ? license.category.name : 'Uncategorized';
        const seats = license.seats || 0;
        const available = license.free_seats_count || 0;
        const used = seats - available;
        const expiration = license.expiration_date ? license.expiration_date.formatted : 'No expiration';
        
        response += `*${index + 1}. ${name}*\n`;
        response += `   📂 Category: ${category}\n`;
        response += `   💺 Seats: ${used}/${seats} used (${available} available)\n`;
        response += `   📅 Expires: ${expiration}\n\n`;
      });
      
      response += `_Use /getlicense <name> for detailed information_`;
      
      await sock.sendMessage(from, { text: response });
    } catch (error) {
      console.error('Error in /licenses command:', error);
      await sock.sendMessage(from, { text: `❌ Error: ${error.message}` });
    }
  }
  
  else if (text.startsWith('/getlicense')) {
    try {
      const parts = text.split(' ');
      if (parts.length < 2) {
        await sock.sendMessage(from, { 
          text: '❌ Usage: /getlicense <license_name_or_id>\n\nExample: /getlicense "Microsoft Office"' 
        });
        return;
      }
      
      const identifier = parts.slice(1).join(' ');
      const result = await getLicenseByName(identifier);
      
      if (!result.success) {
        let errorMsg = `❌ ${result.error}`;
        if (result.suggestions && result.suggestions.length > 0) {
          errorMsg += `\n\n*Suggestions:*\n${result.suggestions.map(s => `• ${s}`).join('\n')}`;
        }
        await sock.sendMessage(from, { text: errorMsg });
        return;
      }
      
      const license = result.license;
      const name = license.name || 'Unnamed License';
      const category = license.category ? license.category.name : 'Uncategorized';
      const manufacturer = license.manufacturer ? license.manufacturer.name : 'Unknown';
      const seats = license.seats || 0;
      const available = license.free_seats_count || 0;
      const used = seats - available;
      const expiration = license.expiration_date ? license.expiration_date.formatted : 'No expiration';
      const notes = license.notes || 'No notes';
      const purchaseDate = license.purchase_date ? license.purchase_date.formatted : 'Unknown';
      const purchaseCost = license.purchase_cost || 'Unknown';
      
      let response = `*📄 License Details*\n\n`;
      response += `*Name:* ${name}\n`;
      response += `*ID:* ${license.id}\n`;
      response += `*Category:* ${category}\n`;
      response += `*Manufacturer:* ${manufacturer}\n`;
      response += `*Seats:* ${used}/${seats} used (${available} available)\n`;
      response += `*Expiration:* ${expiration}\n`;
      response += `*Purchase Date:* ${purchaseDate}\n`;
      response += `*Purchase Cost:* ${purchaseCost}\n`;
      response += `*Notes:* ${notes}`;
      
      await sock.sendMessage(from, { text: response });
    } catch (error) {
      console.error('Error in /getlicense command:', error);
      await sock.sendMessage(from, { text: `❌ Error: ${error.message}` });
    }
  }
  
  else if (text.startsWith('/expiring')) {
    try {
      const parts = text.split(' ');
      const days = parts[1] && !isNaN(parts[1]) ? parseInt(parts[1]) : 30;
      
      const result = await getExpiringLicenses(days);
      
      if (!result.success) {
        await sock.sendMessage(from, { text: `❌ Error fetching expiring licenses: ${result.error}` });
        return;
      }
      
      if (result.licenses.length === 0) {
        await sock.sendMessage(from, { text: `✅ No licenses expiring within ${days} days.` });
        return;
      }
      
      let response = `*⚠️ Licenses Expiring in ${days} Days (${result.total} found)*\n\n`;
      
      result.licenses.forEach((license, index) => {
        const name = license.name || 'Unnamed License';
        const category = license.category ? license.category.name : 'Uncategorized';
        const expiration = license.expiration_date.formatted;
        const seats = license.seats || 0;
        const available = license.free_seats_count || 0;
        const used = seats - available;
        
        // Calculate days until expiration
        const expirationDate = new Date(license.expiration_date.date);
        const currentDate = new Date();
        const daysUntilExpiration = Math.ceil((expirationDate - currentDate) / (1000 * 60 * 60 * 24));
        
        response += `*${index + 1}. ${name}*\n`;
        response += `   📂 Category: ${category}\n`;
        response += `   💺 Usage: ${used}/${seats} seats\n`;
        response += `   📅 Expires: ${expiration} (${daysUntilExpiration} days)\n\n`;
      });
      
      await sock.sendMessage(from, { text: response });
    } catch (error) {
      console.error('Error in /expiring command:', error);
      await sock.sendMessage(from, { text: `❌ Error: ${error.message}` });
    }
  }
  
  else if (text.startsWith('/licensereport')) {
    try {
      const result = await getLicenseUtilization();
      
      if (!result.success) {
        await sock.sendMessage(from, { text: `❌ Error generating license report: ${result.error}` });
        return;
      }
      
      const data = result.data;
      
      let response = `*📊 License Utilization Report*\n\n`;
      response += `*📈 Overview:*\n`;
      response += `• Total Licenses: ${data.totalLicenses}\n\n`;
      
      response += `*💺 Utilization:*\n`;
      response += `• Fully Utilized (100%): ${data.utilization.fullyUtilized}\n`;
      response += `• Partially Utilized (50-99%): ${data.utilization.partiallyUtilized}\n`;
      response += `• Under Utilized (1-49%): ${data.utilization.underUtilized}\n`;
      response += `• Not Utilized (0%): ${data.utilization.notUtilized}\n\n`;
      
      response += `*📅 Expiration Status:*\n`;
      response += `• Expired: ${data.expiration.expired}\n`;
      response += `• Expiring Soon (30 days): ${data.expiration.expiringSoon}\n`;
      response += `• Valid: ${data.expiration.valid}\n`;
      response += `• No Expiration: ${data.expiration.noExpiration}\n\n`;
      
      response += `*📂 By Category:*\n`;
      Object.entries(data.categories).forEach(([category, info]) => {
        const utilizationPercent = info.totalSeats > 0 ? Math.round((info.usedSeats / info.totalSeats) * 100) : 0;
        response += `• ${category}: ${info.count} licenses, ${info.usedSeats}/${info.totalSeats} seats (${utilizationPercent}%)\n`;
      });
      
      response += `\n_Generated: ${new Date(result.generatedAt).toLocaleString('en-GB', { timeZone: 'Asia/Jakarta' })}_`;
      
      await sock.sendMessage(from, { text: response });
    } catch (error) {
      console.error('Error in /licensereport command:', error);
      await sock.sendMessage(from, { text: `❌ Error: ${error.message}` });
    }
  }
  // ===== END LICENSE MANAGEMENT COMMANDS =====

  // ===== ALERT ACKNOWLEDGEMENT COMMAND =====
  else if (text.startsWith('/ack')) {
    try {
      // Extract alert ID from the message
      const parts = text.split(/\s+/);
      let alertId = null;
      
      if (parts.length > 1) {
        // Direct format: /ack <alert-id>
        alertId = parts[1];
      } else {
        // Try to extract from quoted message or context
        let searchText = text;
        
        // Check if this is a quoted/replied message
        if (message.message.extendedTextMessage && message.message.extendedTextMessage.contextInfo) {
          const quotedMessage = message.message.extendedTextMessage.contextInfo.quotedMessage;
          if (quotedMessage) {
            // Extract text from quoted message
            const quotedText = quotedMessage.conversation || 
                             quotedMessage.extendedTextMessage?.text || 
                             quotedMessage.imageMessage?.caption || 
                             quotedMessage.documentMessage?.caption || '';
            searchText += ' ' + quotedText;
          }
        }
        
        // Look for UUID pattern in the combined text
        const uuidRegex = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
        const match = searchText.match(uuidRegex);
        if (match) {
          alertId = match[0];
        }
      }
      
      if (!alertId) {
        await sock.sendMessage(from, { 
          text: '❌ Alert ID not found. Please reply to an alert message with /ack or use format: /ack <alert-id>' 
        });
        return;
      }
      
      // Validate UUID format
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!uuidRegex.test(alertId)) {
        await sock.sendMessage(from, { 
          text: '❌ Invalid alert ID format. Please provide a valid UUID.' 
        });
        return;
      }
      
      // Use environment variable for API base URL
      const veeamApiBaseUrl = process.env.VEEAM_API_BASE_URL || 'http://localhost:3005/api';
      
      // Call the Veeam backend API to acknowledge the alert
      const response = await fetch(`${veeamApiBaseUrl}/alerts/${alertId}/acknowledge`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        }
      });
      
      if (response.ok) {
        const result = await response.json();
        await sock.sendMessage(from, { 
          text: `✅ Alert ${alertId} has been acknowledged successfully.` 
        });
        console.log(`Alert ${alertId} acknowledged via WhatsApp by ${from}`);
      } else {
        const errorData = await response.json().catch(() => ({ message: 'Unknown error' }));
        await sock.sendMessage(from, { 
          text: `❌ Failed to acknowledge alert: ${errorData.message || 'Unknown error'}` 
        });
        console.error(`Failed to acknowledge alert ${alertId}:`, errorData);
      }
      
    } catch (error) {
      console.error('Error in /ack command:', error);
      await sock.sendMessage(from, { 
        text: `❌ Error acknowledging alert: ${error.message}` 
      });
    }
  }
  // ===== END ALERT ACKNOWLEDGEMENT COMMAND =====

  else if (text === '/clearthread') {
      const result = await clearAllThreadKeys();
      if (result.success) {
          await sock.sendMessage(from, { text: result.message });
      } else {
          await sock.sendMessage(from, { text: 'Error: ' + result.message });
      }
  } else {
      await sock.sendMessage(from, { text: 'Error: Command not recognized.' });
  }
};

// const extractFileName = (message) => {
//   return message.message.documentMessage ? message.message.documentMessage.fileName :
//     message.message.documentWithCaptionMessage ? message.message.documentWithCaptionMessage.message.documentMessage.fileName : null;
// };
const extractFileName = (message) => {
  // Extract file name for document messages
  if (message.message.documentMessage) {
    return message.message.documentMessage.fileName;
  }

  // Extract file name for document messages with caption
  if (message.message.documentWithCaptionMessage) {
    return message.message.documentWithCaptionMessage.message.documentMessage.fileName;
  }

  // Extract file name for image messages
  if (message.message.imageMessage) {
    // Use fileName if provided, otherwise derive from MIME type
    const imageMessage = message.message.imageMessage;
    return imageMessage.fileName || `image.${mime.extension(imageMessage.mimetype)}`;
  }

  return null;
};


const extractMessageContent = (message) => {
  return message.message.conversation ? message.message.conversation :
    message.message.imageMessage ? message.message.imageMessage.caption :
    message.message.documentMessage ? message.message.documentMessage.caption :
    message.message.documentWithCaptionMessage ? message.message.documentWithCaptionMessage.message.documentMessage.caption :
    message.message.videoMessage ? message.message.videoMessage.caption :
    message.message.extendedTextMessage ? message.message.extendedTextMessage.text :
    message.message.buttonsResponseMessage ? message.message.buttonsResponseMessage.selectedButtonId :
    message.message.listResponseMessage ? message.message.listResponseMessage.singleSelectReply.selectedRowId :
    message.message.templateButtonReplyMessage ? message.message.templateButtonReplyMessage.selectedId :
    message.message.buttonsResponseMessage?.selectedButtonId || message.message.listResponseMessage?.singleSelectReply.selectedRowId || message.text;
};

const isReactionFromSpecificGroups = (reaction, groupIds) => {
  return groupIds.includes(reaction.key.remoteJid);
};

const specificGroupIds = [
  '120363162455880145@g.us', // Group 1
  '120363215673098371@g.us', // Group 2
];


        
//         // Add this event listener to handle incoming messages
//         sock.ev.on('messages.upsert', async (m) => {
//           const message = m.messages[0];
//           if (!message.message) return;
//           message.message = Object.keys(message.message)[0] === "ephemeralMessage" ? message.message.ephemeralMessage.message : message.message;
//           console.log('Received a new message:', message);

//           // Differentiating message content
//           const body = extractMessageContent(message);
//           const hasImage = message.message.imageMessage !== undefined;
//           //hasImage = message.message.imageMessage;
  
//           if (body || hasImage) {
//               if (body) {
//                   console.log(body);
//                   // Store the message only if it contains "New request"
//                   if (body.includes("New request")) {
//                       const key = `${message.key.remoteJid}_${message.key.id}`;
//                       storeMessage(message.key.id, message.key.remoteJid, JSON.stringify(message.message));
//                   }
//               }
//               if (message && message.key && message.key.remoteJid) {
//                   await handleMessage(sock, message);
//               } else {
//                   console.error('Invalid message structure:', message);
//               }
//           } else {
//               console.log('Received a message without text content:', message);
//           }
//         });
//         sock.ev.on('auth_failure', (session) => {
//             console.log('Authentication failed');
//             currentStatus = 'Auth failure, restarting...';
//             io.emit('message', currentStatus);
//         });
//         sock.ev.on('disconnected', (reason) => {
//             console.log('Disconnected:', reason);
//             currentStatus = 'WhatsApp is disconnected!';
//             io.emit('message', currentStatus);
//             sock.destroy();
//             startSock();
//         });

//         // Handle incoming reactions
//         sock.ev.on('messages.reaction', async (reaction) => {
//           if (!isReactionFromSpecificGroups(reaction[0], specificGroupIds)) {
//             console.log('Reaction not from the specified groups. Ignoring...');
//             return;
//           }
    
//           console.log('Reaction from a monitored group detected:', reaction[0]);
//           //console.log('Reaction detected:', reaction);
//           if (reaction && reaction.length > 0) {
//             const reactionMessage = reaction[0];
//             //const specificGroupId = '120363215673098371@g.us';
//             // if (reactionMessage.key.remoteJid !== specificGroupId) {
//             //   console.log('Reaction not from the specified group. Ignoring...');
//             //   return;
//             // }
        
//             const messageId = reactionMessage.key.id;
//             console.log('Message ID:', messageId);
//             const reacterId = reactionMessage.reaction.key.participant;
//             console.log('Reacter ID:', reacterId);
        
//             if (!reacterId) {
//               console.error('Participant is undefined:', reactionMessage);
//               return;
//             }
        
//             const reacterNumber = phoneNumberFormatter(reacterId.split('@')[0]);
        
//             try {
//               let technician;
//               let ictTechnician = 'Not registered';
//               try {
//                 technician = getContactByPhone(reacterNumber);
//                 if (technician) {
//                   ictTechnician = technician.ict_name;
//                 } else {
//                   console.warn(`Technician not found for reacter number: ${reacterNumber}`);
//                 }
//               } catch (error) {
//                 console.error('Error fetching technician by phone:', error.message);
//               }
//               console.log(`${ictTechnician} is reacting to the message`);
//               // getMessage(messageId, reactionMessage.key.remoteJid, async (message) => {
//               //   console.log('Message callback executed');
//               //   console.log('Message:', message);
//               // });

//               getMessage(messageId, reactionMessage.key.remoteJid, async (err, message) => {
//                 if (err) {
//                     console.error('Error fetching message:', err.message);
//                     return;
//                 }
            
//                 if (!message) {
//                     console.warn(`Message not found in Redis for key: ${reactionMessage.key.remoteJid}_${messageId}`);
//                     return;
//                 }
            
//                 console.log('Message fetched successfully:', message);

//                 // Proceed with your logic here
//                 let messageContent;
//                 try {
//                   messageContent = JSON.parse(message.message);
//                 } catch (parseError) {
//                   console.error('Error parsing message content:', parseError);
//                   console.error('Malformed JSON:', message.message);
//                   return;
//                 }
      
//                 const messageText = messageContent.extendedTextMessage?.text || messageContent.conversation;
      
//                 if (messageText) {
//                   const ticketNumberMatch = messageText.match(/\*Ticket number:\* (\d+)/);
//                   if (ticketNumberMatch) {
//                     const ticketNumber = ticketNumberMatch[1];
//                     console.log(`Extracted ticket number: ${ticketNumber}`);
      
//                     try {
//                       const workOrderResponse = await axios.get(`${base_url}requests/${ticketNumber}`, { headers, httpsAgent });
//                       const workOrder = workOrderResponse.data.request;
//                       const requesterMobile = workOrder.requester.mobile ? phoneNumberFormatter(workOrder.requester.mobile) : 'N/A';
//                       let requesterName = workOrder.requester.name.replace('[MTI]', '').trim();
      
//                       if (!message.reacted) {
//                         await assignICTTechnician(ticketNumber, ictTechnician);
//                         markMessageAsReacted(messageId, reactionMessage.key.remoteJid, reacterNumber);
      
//                         // You may uncomment the following lines if needed for notifying the requester.
//                         /*
//                         const notifyNumber = requesterMobile !== 'N/A' ? requesterMobile : phoneNumberFormatter('085712612218');
//                         const technicianName = technician ? technician.name : reacterNumber;
//                         const notifyMessage = `Dear *${requesterName}*,\n\nYour ticket with number *${ticketNumber}* is now being handled by *${technicianName}*. Please wait while our technician reaches out to you.\n\n*To monitor your request, please see the link below:*\nhttps://helpdesk.merdekabattery.com:8080/WorkOrder.do?woMode=viewWO&woID=${ticketNumber}&PORTALID=1`;
//                         await sock.sendMessage(notifyNumber, { text: notifyMessage });
//                         */
//                       } else {
//                         // Find the reacter's number using the message ID and remote JID
//                         const reacterId = await findReacterNumber(messageId, reactionMessage.key.remoteJid);

//                         // Format the reacter's number to a phone number format
//                         const reacterNumber = phoneNumberFormatter(reacterId.split('@')[0]);
                        
//                         // Get the existing technician's name based on the reacter's phone number
//                         const existingTechnicianName = reacterNumber ? getContactByPhone(reacterNumber).ict_name : "another technician";
                        
//                         // Notify the reacter that the ticket has already been handled by another technician
//                         const notifyReacter = `Sorry, this ticket *${ticketNumber}* has been handled by *${existingTechnicianName}*.`;
                        
//                         // Send the notification message to the reacter
//                         await sock.sendMessage(reactionMessage.key.remoteJid, { text: notifyReacter });
//                       }
//                     } catch (workOrderError) {
//                       console.error('Error fetching work order details:', workOrderError);
//                     }
//                   } else {
//                     console.error('Ticket number not found in message text:', messageText);
//                   }
//                 } else {
//                   console.log('Message text not found or already reacted:', messageId);
//                 }

//               });


//               // getMessage(messageId, reactionMessage.key.remoteJid, async (message) => {
//               //   //console.log('Message:', message);
//               //   if (message) {
//               //     let messageContent;
//               //     try {
//               //       messageContent = JSON.parse(message.message);
//               //     } catch (parseError) {
//               //       console.error('Error parsing message content:', parseError);
//               //       console.error('Malformed JSON:', message.message);
//               //       return;
//               //     }
        
//               //     const messageText = messageContent.extendedTextMessage?.text || messageContent.conversation;
        
//               //     if (messageText) {
//               //       const ticketNumberMatch = messageText.match(/\*Ticket number:\* (\d+)/);
//               //       if (ticketNumberMatch) {
//               //         const ticketNumber = ticketNumberMatch[1];
//               //         console.log(`Extracted ticket number: ${ticketNumber}`);
        
//               //         try {
//               //           const workOrderResponse = await axios.get(`${base_url}requests/${ticketNumber}`, { headers, httpsAgent });
//               //           const workOrder = workOrderResponse.data.request;
//               //           const requesterMobile = workOrder.requester.mobile ? phoneNumberFormatter(workOrder.requester.mobile) : 'N/A';
//               //           let requesterName = workOrder.requester.name.replace('[MTI]', '').trim();
        
//               //           if (!message.reacted) {
//               //             await assignICTTechnician(ticketNumber, ictTechnician);


const startSock = async () => {
  try {
    console.log('Fetching latest Baileys version…')
    const { version } = await fetchLatestBaileysVersion()
    console.log('Using Baileys version:', version)

    console.log('Initializing auth state…')
    const { state, saveCreds } = await useMultiFileAuthState('auth_info')
    console.log('Auth state initialized')

    console.log('Creating WhatsApp socket…')
    sock = makeWASocket({
      version,
      auth: state,
      logger: Pino({ level: 'silent' }),
      browser: Browsers.macOS('Desktop'),
      syncFullHistory: true,
      printQRInTerminal: false,
      cachedGroupMetadata: jid => groupCache.get(jid),
    })

    bindHistory(sock)

    sock.ev.process(async events => {
      // — creds.update —
      if (events['creds.update']) {
        await saveCreds()
      }

      // — connection.update (open / close / QR) —
      if (events['connection.update']) {
        const { connection, lastDisconnect, qr } = events['connection.update']
        console.log('connection.update:', connection, lastDisconnect, qr)

        if (connection === 'close') {
          const shouldReconnect =
            lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut
          currentStatus = 'Disconnected, reconnecting…'
          isAuthenticated = false
          currentQr = null
          io.emit('message', currentStatus)

          if (shouldReconnect) {
            await sock.end()         // <— gracefully shut down old socket
            return startSock()       // <— start fresh and exit this handler
          }
        }

        if (connection === 'open') {
          console.log('Connected to WhatsApp')
          currentStatus = 'WhatsApp is ready!'
          isAuthenticated = true
          currentQr = null
          io.emit('ready', currentStatus)
          io.emit('message', currentStatus)
          io.emit('authenticated', currentStatus)

          await listGroups()

          const testNumber = phoneNumberFormatter('085712612218')
          console.log('Testing sendMessage to', testNumber)
          try {
            const resp = await sock.sendMessage(testNumber, {
              text: 'MTI Whatsapp API Started!'
            })
            console.log('Test message sent:', resp)
          } catch (err) {
            console.error('Error sending test message:', err)
          }
        }

        if (qr && !isAuthenticated) {
          console.log('QR received, generating DataURL…')
          try {
            const url = await qrcode.toDataURL(qr)
            currentQr = url
            io.emit('qr', url)
            currentStatus = 'QR Code received, scan please!'
            io.emit('message', currentStatus)
          } catch (err) {
            console.error('Error generating QR code:', err)
          }
        }
      }

      // — group cache updates —
      if (events['groups.upsert']) {
        for (const g of events['groups.upsert']) {
          groupCache.set(g.id, g)
        }
      }
      if (events['groups.update']) {
        for (const u of events['groups.update']) {
          const prev = groupCache.get(u.id) || {}
          groupCache.set(u.id, { ...prev, ...u })
        }
      }
      if (events['group-participants.update']) {
        for (const p of events['group-participants.update']) {
          groupCache.del(p.id)
        }
      }

      // — incoming messages —
      if (events['messages.upsert']) {
        const up = events['messages.upsert']
        if (Array.isArray(up.messages)) {
          for (const msg of up.messages) {
            // skip messages we sent ourselves
            //if (msg.key.fromMe) continue

            if (!msg.message) continue

            // unwrap ephemeral
            if (msg.message.ephemeralMessage) {
              msg.message =
                msg.message.ephemeralMessage.message || msg.message
            }

            const body = extractMessageContent(msg)?.trim()

            // Process message for contact mapping
            processMessageForMapping(msg)

            // persist "New request"
            if (body && body.includes('New request')) {
              console.log('Storing ticket message:', body)
              storeMessage(
                msg.key.id,
                msg.key.remoteJid,
                JSON.stringify(msg.message)
              )
            }

            // delegate all message logic
            if (msg.key.remoteJid) {
              try {
                await handleMessage(sock, msg)
              } catch (e) {
                console.error('Error in handleMessage:', e)
              }
            }
          }
        }
      }

      // — reactions —
      if (events['messages.reaction']) {
        for (const reaction of events['messages.reaction']) {
          console.log('Reaction event:', reaction)
          if (!isReactionFromSpecificGroups(reaction, specificGroupIds)) {
            // skip this one, but keep processing any others
            console.log('Reaction not from the specified groups. Ignoring…');
            continue
          }

          const { id: messageId, remoteJid } = reaction.key
          const participant =
            reaction.reaction?.key?.participant || ''
          console.log('Participant:', participant)
          
          // Process reaction for contact mapping
          processReactionForMapping(reaction)
          
          // Use enhanced phone number resolution
          const reacterNumber = resolvePhoneNumber(participant)
          console.log('Reacter number:', reacterNumber)

          let ictTech = 'Not registered'
          if (reacterNumber) {
            try {
              const tech = getContactByPhone(reacterNumber)
              //console.log('Technician:', tech);
              if (tech) ictTech = tech.ict_name
              else console.warn(
                `Technician not found for reacter number: ${reacterNumber}`
              )
            } catch {
              console.error(
                'Error fetching technician by phone:',
                reacterNumber
              )
            }
          } else {
            console.log(`Skipping technician lookup for unmapped LID: ${participant}`)
          }

          getMessage(
            messageId,
            remoteJid,
            async (err, stored) => {
              if (err || !stored) {
                console.error(
                  'Error fetching message from store:',
                  err || 'Message not found in Redis store'
                )
                return
              }
              let content
              try {
                content = JSON.parse(stored.message)
              } catch {
                return console.error(
                  'Malformed stored message JSON'
                )
              }
              const text =
                content.extendedTextMessage?.text ||
                content.conversation
              const m = text?.match(
                /\*Ticket number:\* (\d+)/
              )
              if (!m)
                return console.error(
                  'Ticket number not found'
                )

              const ticket = m[1]
              try {
                const { data } = await axios.get(
                  `${base_url}requests/${ticket}`,
                  { headers, httpsAgent }
                )
                if (!stored.reacted) {
                  await assignICTTechnician(ticket, ictTech)
                  markMessageAsReacted(
                    messageId,
                    remoteJid,
                    reacterNumber
                  )
                } else {
                  // const prev = /* lookup original reactor */
                  // await sock.sendMessage(remoteJid, {
                  //   text: `Sorry, ticket *${ticket}* sudah di-handle oleh *${prev}*.`
                  // })
                  //Find the reacter's number using the message ID and remote JID
                  const originalReacterJid = await findReacterNumber(messageId, remoteJid)

                  //Format the reacter's number to a phone number format using enhanced resolution
                  const originalReacterNumber = resolvePhoneNumber(originalReacterJid);

                  // Get the existing technician's name based on the reacter's phone number
                  const existingTechnicianName = originalReacterNumber ? getContactByPhone(originalReacterNumber).ict_name : "another technician";

                  // Notify the reacter that the ticket has already been handled by another technician
                  const notifyReacter = `Sorry, ticket *${ticket}* has been handled by *${existingTechnicianName}*.`;
                  // Send the notification message to the reacter
                  await sock.sendMessage(remoteJid, { text: notifyReacter });
                }
              } catch (e) {
                console.error(
                  'Error fetching work order:',
                  e
                )
              }
            }
          )
        }
      }
    })

    console.log('Socket created; listening for events…')
    initializeSock(sock)
    // catch any auth failure and restart
    sock.ev.on('auth_failure', () => {
      console.error('Auth failure—restarting socket…')
      sock.end().catch(() => {})
      startSock()
    })
    // catch a hard disconnect and restart
    sock.ev.on('disconnected', (reason) => {
      console.warn('Socket disconnected:', reason)
      sock.destroy()
      startSock()
    })
    // graceful shutdown
    process.on('exit', saveAlarms)
    process.on('SIGINT', saveAlarms)
    process.on('SIGTERM', saveAlarms)
  } catch (error) {
    console.error('Error in startSock:', error)
  }
}



console.log('Starting WhatsApp socket...');
startSock();

// Periodically clean up old messages (e.g., once a day)
setInterval(cleanupOldMessages, 24 * 60 * 60 * 1000); // 24 hours



app.post(
  '/send-message',
  checkIP,
  upload.single('image'),                // ← your multer({ storage })
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








// Helper function to introduce delay
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

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

// Bulk message endpoint with delay
app.post('/send-bulk-message', checkIP, async (req, res) => {
  const { message, numbers, minDelay, maxDelay } = req.body;

  if (!message || !numbers) {
    return res.status(400).json({ status: false, message: 'Message and numbers are required.' });
  }

  if (!minDelay || !maxDelay) {
    return res.status(400).json({ status: false, message: 'Minimum and maximum delay are required.' });
  }

  try {
    console.log('Received numbers array:', numbers); // Log the entire numbers array

    for (const number of numbers) {
      console.log('Sending message to:', number); // Log each number during the loop
      await sendMessage(number, message); // Your function to send WhatsApp message
      const delayDuration = Math.floor(Math.random() * (maxDelay - minDelay + 1)) + minDelay;
      console.log(`Waiting for ${delayDuration} miliseconds before sending the next message.`);
      //await delay(delayDuration * 1000); // Convert seconds to milliseconds
      await delay(delayDuration); // Convert seconds to milliseconds
    }

    res.status(200).json({ status: true, message: 'Messages sent successfully.' });
  } catch (error) {
    console.error('Error sending bulk messages:', error);
    res.status(500).json({ status: false, message: error.message });
  }
});





//const templates = []; // In-memory template storage

// File path to store templates
const templatesFilePath = path.join(__dirname, 'templates.json');

// Helper function to read templates from the file
const readTemplatesFromFile = () => {
  try {
    if (!fs.existsSync(templatesFilePath)) {
      // If the file doesn't exist, create it with an empty array
      fs.writeFileSync(templatesFilePath, JSON.stringify([]));
    }
    const data = fs.readFileSync(templatesFilePath, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error('Error reading templates from file:', error);
    return [];
  }
};

// Helper function to write templates to the file
const writeTemplatesToFile = (templates) => {
  try {
    fs.writeFileSync(templatesFilePath, JSON.stringify(templates, null, 2));
  } catch (error) {
    console.error('Error writing templates to file:', error);
  }
};

// Load templates from the file at startup
let templates = readTemplatesFromFile();

// Endpoint to save a template
app.post('/templates', (req, res) => {
  const { name, message, numbers } = req.body;
  if (!name || !message || !numbers) {
    return res.status(400).json({ status: false, message: 'Name, message, and numbers are required.' });
  }

  const template = { name, message, numbers };
  templates.push(template);
  writeTemplatesToFile(templates);
  res.status(201).json({ status: true, message: 'Template saved successfully.' });
});// Endpoint to get all templates
app.get('/templates', (req, res) => {
  res.json(templates);
});

// Endpoint to delete a template
app.delete('/templates/:name', (req, res) => {
  const { name } = req.params;
  const index = templates.findIndex(template => template.name === name);
  if (index !== -1) {
    templates.splice(index, 1);
    writeTemplatesToFile(templates);
    res.json({ message: 'Template deleted successfully' });
  } else {
    res.status(404).json({ message: 'Template not found' });
  }
});

app.post('/send-group-message', checkIP, upload.fields([{ name: 'document', maxCount: 1 }, { name: 'image', maxCount: 1 }]), [
  body('id').custom((value, { req }) => {
      if (!value && !req.body.name) {
          throw new Error('Invalid value, you can use `id` or `name`');
      }
      return true;
  }),
  body('message').optional().notEmpty().withMessage('Message cannot be empty'),
], async (req, res) => {
  console.log('Received group message request data:', req.body);
  console.log('Received files:', req.files);

  const errors = validationResult(req).formatWith(({ msg }) => msg);
  if (!errors.isEmpty()) {
      console.log('Validation errors:', errors.mapped());
      return res.status(422).json({
          status: false,
          message: errors.mapped()
      });
  }

  let chatId = req.body.id;
  const groupName = req.body.name;
  const message = req.body.message;
  const document = req.files && req.files['document'] ? req.files['document'][0] : null;
  const image = req.files && req.files['image'] ? req.files['image'][0] : null;
  //const mentionedJid = req.body.mention ? `${req.body.mention}@s.whatsapp.net` : null;

  let mentionedJids=[];
  if (req.body.mention) {
    try {
        const mentions = JSON.parse(req.body.mention); // Parse mentions array from frontend
        console.log('Mentions:', mentions);
        mentionedJids = mentions.map(mention => `${mention}@s.whatsapp.net`);
        //mentionedJids = mentions.map(mention => mention.jid || `${mention.phone}@s.whatsapp.net`);
        console.log('Processed mentions:', mentionedJids);
    } catch (error) {
        console.error('Error parsing mentions:', error.message);
    }
  }

  // Validate group ID format - if provided ID doesn't look like a valid WhatsApp group ID, treat it as a group name
  if (chatId && !chatId.includes('@g.us')) {
      console.log(`Provided ID '${chatId}' is not a valid WhatsApp group ID format. Treating as group name.`);
      const group = await findGroupByName(chatId);
      if (!group) {
          return res.status(422).json({
              status: false,
              message: 'No group found with name: ' + chatId
          });
      }
      chatId = group.id;
  } else if (!chatId) {
      const group = await findGroupByName(groupName);
      if (!group) {
          return res.status(422).json({
              status: false,
              message: 'No group found with name: ' + groupName
          });
      }
      chatId = group.id;
  }

  try {
      if (document) {
          const documentBuffer = fs.readFileSync(document.path);
          let doctype;
          if (document.originalname.endsWith('.xlsx')) {
              doctype = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
          } else if (document.originalname.endsWith('.pdf')) {
              doctype = 'application/pdf';
          } else {
              doctype = 'application/octet-stream';
          }
          await sock.sendMessage(chatId, {
              document: documentBuffer,
              mimetype: doctype,
              fileName: document.originalname,
              caption: message || '',
              mentions: mentionedJids || []
          }).then(response => {
              console.log('Group document message sent:', response);
              res.status(200).json({
                  status: true,
                  response: response
              });
              fs.unlinkSync(document.path);
          }).catch(err => {
              console.error('Error sending group document message:', err);
              res.status(500).json({
                  status: false,
                  response: err.toString()
              });
              fs.unlinkSync(document.path);
          });
      } else if (image) {
          const imageBuffer = fs.readFileSync(image.path);
          await sock.sendMessage(chatId, {
              image: imageBuffer,
              caption: message || '',
              mentions: mentionedJids || []
          }).then(response => {
              console.log('Group image message sent:', response);
              res.status(200).json({
                  status: true,
                  response: response
              });
              fs.unlinkSync(image.path);
          }).catch(err => {
              console.error('Error sending group image message:', err);
              res.status(500).json({
                  status: false,
                  response: err.toString()
              });
              fs.unlinkSync(image.path);
          });
      } else {
          await sock.sendMessage(chatId, {
              text: message || 'Hello',
              mentions: mentionedJids || []
          }).then(response => {
              console.log('Group message sent:', response);
              res.status(200).json({
                  status: true,
                  response: response
              });
          }).catch(err => {
              console.error('Error sending group message:', err);
              res.status(500).json({
                  status: false,
                  response: err.toString()
              });
          });
      }
  } catch (err) {
      console.error('Error sending group message:', err);
      res.status(500).json({
          status: false,
          response: err.toString()
      });
  }
});




// Function to strip HTML tags and decode HTML entities
function stripHtmlTagsAndDecode(str) {
  return decode(str.replace(/<[^>]*>?/gm, ''));
}

// Function to truncate description
// Truncate or summarize the description to no more than 200 characters using OpenAI if needed
async function truncateDescription(description, length = 200) {
  console.log(`[truncateDescription] Called with description length: ${description.length}, limit: ${length}`);
  if (description.length <= length) {
    console.log('[truncateDescription] Description is within limit, returning as is.');
    return description;
  }
  try {
    // Use OpenAI to summarize the description to fit within the length
    const prompt = `Summarize the following request in no more than ${length} characters:\n\n${description}`;
    console.log('[truncateDescription] Sending prompt to OpenAI:', prompt.slice(0, 200) + (prompt.length > 200 ? '...' : ''));
    const chatCompletion = await openai.chat.completions.create({
      messages: [{ role: 'user', content: prompt }],
      model: 'gpt-4o-mini',
      max_tokens: 100,
    });
    let summary = chatCompletion.choices[0].message.content.trim();
    console.log(`[truncateDescription] OpenAI summary received (length: ${summary.length}):`, summary);
    // Ensure the summary does not exceed the length
    if (summary.length > length) {
      console.log('[truncateDescription] OpenAI summary exceeds limit, truncating.');
      summary = summary.substring(0, length) + '...';
    }
    console.log('[truncateDescription] Final summary:', summary);
    return summary;
  } catch (err) {
    // Fallback plan if OpenAI fails (timeout, network, etc.)
    console.error('[truncateDescription] OpenAI summarization failed, using fallback:', err && err.message ? err.message : err);
    // Try to find a sentence boundary before the limit
    let truncated = description.substring(0, length);
    const lastPeriod = truncated.lastIndexOf('.');
    if (lastPeriod > 50) {
      console.log('[truncateDescription] Fallback: Found period at', lastPeriod, ', truncating at sentence boundary.');
      truncated = truncated.substring(0, lastPeriod + 1);
    } else {
      console.log('[truncateDescription] Fallback: No suitable period found, truncating at character limit.');
    }
    const result = truncated.trim() + '...';
    console.log('[truncateDescription] Fallback result:', result);
    return result;
  }
}

// Function to get the previous state of the ticket
async function getPreviousTicketState(workorderid) {
  const state = await redis.get(`ticket:${workorderid}`);
  return state ? JSON.parse(state) : null;
}

// Function to store the current state of the ticket
async function storeCurrentTicketState(workorderid, currentState) {
  await redis.set(`ticket:${workorderid}`, JSON.stringify(currentState));
}


// // Function to assign a technician to a request
// async function assignTechnicianToRequest(requestId, technicianRole, groupName) {
//   const assignUrl = `${base_url}requests/${requestId}/assign`;

//   // Data to assign the technician and group
//   const assignData = {
//       request: {
//           group: {
//               name: groupName
//           },
//           technician: {
//               name: technicianRole
//           }
//       }
//   };

//   // Convert the assign_data to URL-encoded form data
//   const data = `input_data=${encodeURIComponent(JSON.stringify(assignData))}`;

//   try {
//       console.log(`Assigning technician role ${technicianRole} to group ${groupName} for ticket ${requestId}`);
//       console.log('Sending request to assign technician...');
//       console.log(`Assign URL: ${assignUrl}`);
//       console.log(`Assign Data: ${data}`);

//       // Making the API request to assign the technician to the request
//       const response = await axios.put(assignUrl, data, { headers, httpsAgent: agent });
//       console.log('Assign Technician Response:', response.data);
//   } catch (error) {
//       if (error.response) {
//           console.error('HTTP error occurred:', error.response.status);
//           console.error('Response Headers:', error.response.headers);
//           console.error('Response Data:', JSON.stringify(error.response.data, null, 2));
//       } else {
//           console.error('An error occurred:', error.message);
//       }
//       throw error; // Rethrow the error to be caught by the caller
//   }
// }

// Function to update a change request's priority to High and modify UDF fields
async function assignICTTechnician(changeId, ictTechnician) {
  const updateUrl = `${base_url}requests/${changeId}`;
  
  // Update data to change priority to High and modify UDF fields
  const updateData = {
      request: {
          udf_fields: {
              udf_pick_601: ictTechnician
          }
      }
  };
  
  // Convert the update_data to URL-encoded form data
  const data = `input_data=${encodeURIComponent(JSON.stringify(updateData))}`;
  
  try {
      console.log('Sending request to update change...');
      // Making the API request to update the change request
      const response = await axios.put(updateUrl, data, { headers, httpsAgent: agent });
      //console.log('Update Change Response:', response.data);
  } catch (error) {
      if (error.response) {
          console.error('HTTP error occurred:', error.response.status, error.response.data);
      } else {
          console.error('An error occurred:', error.message);
      }
  }
}

// Function to tag a request as updated by the bot
async function tagUpdatedByBot(changeId) {
  const updateUrl = `${base_url}requests/${changeId}`;
  
  // Update data to set udf_pick_902 to 'True'
  const updateData = {
      request: {
          udf_fields: {
              udf_pick_902: 'True' // Tagging as updated by bot
          }
      }
  };
  
  // Convert the update_data to URL-encoded form data
  const data = `input_data=${encodeURIComponent(JSON.stringify(updateData))}`;
  
  try {
      console.log('Sending request to tag as updated by bot...');
      // Making the API request to update the change request
      const response = await axios.put(updateUrl, data, { headers, httpsAgent: agent });
      console.log('Tag Updated Response:', response.data);
  } catch (error) {
      if (error.response) {
          console.error('HTTP error occurred:', error.response.status, error.response.data);
      } else {
          console.error('An error occurred:', error.message);
      }
  }
}
// Function to assign a technician to a request
async function assignTechnicianToRequest(requestId, technicianRole, groupName) {
  const assignUrl = `${base_url}requests/${requestId}/assign`;

  // Data to assign the technician and group
  const assignData = {
      request: {
          group: {
              name: groupName
          },
          technician: {
              name: technicianRole
          }
      }
  };

  // Convert the assign_data to URL-encoded form data
  const data = `input_data=${encodeURIComponent(JSON.stringify(assignData))}`;

  try {
      console.log(`Assigning technician role ${technicianRole} to group ${groupName} for ticket ${requestId}`);
      console.log('Sending request to assign technician...');
      console.log(`Assign URL: ${assignUrl}`);
      console.log(`Assign Data: ${data}`);

      // Making the API request to assign the technician to the request
      const response = await axios.put(assignUrl, data, { headers, httpsAgent: agent });
      console.log('Assign Technician Response:', response.data);

      //await storeCurrentTicketState(requestId, { technician: ictTechnician });
      // Optionally ensure tagging is enforced
      //await tagUpdatedByBot(requestId);
  } catch (error) {
      if (error.response) {
          console.error('HTTP error occurred:', error.response.status);
          console.error('Response Headers:', error.response.headers);
          console.error('Response Data:', JSON.stringify(error.response.data, null, 2));
      } else {
          console.error('An error occurred:', error.message);
      }
      throw error; // Rethrow the error to be caught by the caller
  }
}


// Function to update the template of a request
async function updateTemplate(changeId, templateId='305', templateName="Submit a New Request", isServiceTemplate=false) {
  // Validate input parameters
  if (!changeId || !templateId || !templateName) {
      console.error('Invalid input parameters. Please provide changeId, templateId, and templateName.');
      return;
  }

  const updateUrl = `${base_url}requests/${changeId}`;
  
  const updateData = {
      request: {
          template: {
              is_service_template: isServiceTemplate,
              service_category: null,
              name: templateName,
              id: templateId
          },
          priority: {
            name: 'Low'
          }
      }
  };
  
  const data = `input_data=${encodeURIComponent(JSON.stringify(updateData))}`;
  
  try {
      console.log(`Sending request to update template for changeId: ${changeId} with templateId: ${templateId}`);
      const response = await axios.put(updateUrl, data, { headers, httpsAgent: agent });
      console.log(`Template '${templateName}' (ID: ${templateId}) has been updated successfully for changeId: ${changeId}.`);
  } catch (error) {
      if (error.response) {
          console.error(`HTTP error occurred while updating template for changeId: ${changeId}. Status: ${error.response.status}, Data:`, error.response.data);
      } else {
          console.error(`An error occurred while updating template for changeId: ${changeId}. Message:`, error.message);
      }
  }
}


app.post('/webhook', checkIP, async (req, res) => {
  try {
      const { id, status, receiver, receiver_type } = req.body;

      if (!validatePayload(req.body)) {
          return res.status(400).json({ error: 'Invalid payload' });
      }

      console.log('Received payload:', req.body);

      // Fetch request details
      const requestObj = await view_request(id);
      console.log('Request Object:', JSON.stringify(requestObj, null, 2));

      // Route to appropriate handler
      if (status === 'new') {
          console.log('Handle new request');
          await handleNewRequest(req.body, requestObj, receiver, receiver_type);
      } else if (status === 'updated') {
        console.log('ticket updated');  
        await handleUpdatedRequest(req.body, requestObj, receiver, receiver_type);
      } else {
          return res.status(400).json({ error: 'Invalid status value' });
      }

      res.status(200).json({ message: 'Notification sent successfully' });
  } catch (error) {
      console.error('Error processing webhook:', error.message);
      res.status(500).json({ error: 'Failed to process webhook' });
  }
});

const validatePayload = (body) => {
  const requiredFields = ['id', 'status', 'receiver', 'receiver_type'];
  return requiredFields.every((field) => field in body && body[field]);
};


async function processTicket(ticketDetails) {
  try {
    // Step 1: Analyze the attachment
    console.log('Analyzing the attachment...');
    const analysisResults = await handleAndAnalyzeAttachments(ticketDetails);

    // Step 2: Combine results and log or notify
    if (analysisResults.length > 0) {
      const combinedAnalysis = analysisResults.map(result => `${result.name}: ${result.analysis}`).join('\n\n');
      const finalSummary = `Ticket Analysis Summary:\n\n${combinedAnalysis}`;
      console.log(finalSummary);

      // Clean up temporary files
      analysisResults.forEach(result => {
        if (result.pdfPath) {
          fs.unlinkSync(result.pdfPath);
          console.log(`Deleted PDF file: ${result.pdfPath}`);
        }
      });

      // Notify a group or individual (uncomment the line below to enable notification)
      // await sock.sendMessage('120363215673098371@g.us', { text: finalSummary });
    } else {
      console.log('No attachments were analyzed.');
    }
  } catch (error) {
    console.error('Error processing ticket:', error.message);
  }
}


// async function processTicket(ticketDetails) {
//     try {
//         // Step 1: Fetch ticket details
//         //const ticketDetails = await view_request(requestId);

//         //console.log('Ticket Details:', ticketDetails);
//         // Step 2: Define prompt
        

//         // Step 3: Handle and analyze attachments
//         console.log('Analyzing the attachment...');
//         const analysisResults = await handleAndAnalyzeAttachments(ticketDetails);

//         // Step 4: Combine results and log or notify
//         if (analysisResults.length > 0) {
//             const combinedAnalysis = analysisResults.map((result) => `${result.name}: ${result.analysis}`).join('\n\n');
//             const finalSummary = `Ticket Analysis Summary:\n\n${combinedAnalysis}`;
//             console.log(finalSummary);

//             analysisResults.forEach(result => {
//                 if (result.pdfPath) {
//                     fs.unlinkSync(result.pdfPath);
//                     console.log(`Deleted PDF file: ${result.pdfPath}`);
//                 }
//             });

//             // Notify a group or individual
//            // await sock.sendMessage('120363215673098371@g.us', { text: finalSummary });
//         } else {
//             console.log('No attachments were analyzed.');
//         }
//     } catch (error) {
//         console.error(`Error processing ticket ${requestId}:`, error.message);
//     }
// }

const handleNewRequest = async (payload, requestObj, receiver, receiver_type) => {
  console.log('Request Object:', JSON.stringify(requestObj, null, 2));
  const {
      id: workorderid,
      requester: { name: createdby, email_id: email, mobile = 'N/A' },
      created_time: { display_value: createdDate },
      subject,
      description,
      status: { name: ticketStatus },
  } = requestObj;


  console.log('Requester Information:', { createdby, email, mobile });

  const { notify_requester_update } = payload;
  //const truncatedDescription = truncateDescription(stripHtmlTagsAndDecode(description));
  const truncatedDescription = await truncateDescription(stripHtmlTagsAndDecode(description),200);
  console.log('Processing new request:', { workorderid, createdby });

  // Step 1: Determine the service category
  const serviceCategory = await defineServiceCategory(workorderid);

  // Step 2: Update the request with service category and template details
  const updateResponse = await updateRequest(workorderid, {
      serviceCategory,
      templateId: '305',
      templateName: 'Submit a New Request',
  });

  if (!updateResponse.success) {
      console.error(`Failed to update request: ${updateResponse.message}`);
      throw new Error(updateResponse.message);
  }

  // Step 3: Construct the notification message
  console.log('Generating notification message...');
  const notificationMessage = generateNotificationMessage(
      createdby, createdDate, email, workorderid, subject, truncatedDescription
  );

  // Step 4: Send notifications
  if (notify_requester_update === 'true' && mobile !== 'N/A' && mobile !== 'undefined') {
      const requesterMessage = `Dear *${createdby}*,\n\nYour ticket \"${subject}\" (ID: ${workorderid}) has been created. Please wait while our team processes your request.\n\n*View your request here:*\nhttps://helpdesk.merdekabattery.com/WorkOrder.do?woMode=viewWO&woID=${workorderid}&PORTALID=1`;
      console.log('Sending message to requester:', requesterMessage);
      if (mobile) {
          await sock.sendMessage(phoneNumberFormatter(mobile), { text: requesterMessage });
      } else {
          const mobileNumber = await findUserMobileByEmail(email);
          if (mobileNumber) {
              await sock.sendMessage(phoneNumberFormatter(mobileNumber), { text: requesterMessage });
          } else {
              console.log('Mobile number not found for the requester.');
          }
      }
  }

  console.log('Sending notification message to receiver:', receiver);
  await sock.sendMessage(receiver, { text: notificationMessage });

  // Step 5: Store the initial ticket state
  console.log('Storing current ticket state...');
  await storeCurrentTicketState(workorderid, { status:'new', ticketStatus, priority: 'Low' });

  // Step 6: Process attachment related to SRF if any
  if (requestObj.attachments && requestObj.attachments.length > 0) {
    console.log('Processing SRF attachment if any...');
    await processTicket(requestObj);
  }
  
};

const handleUpdatedRequest = async (payload, requestObj, receiver, receiver_type) => {
  //console.log('Updated Request Object Structure:', JSON.stringify(requestObj, null, 2));

  // console.log(`handleUpdatedRequest triggered for ticket ID: ${requestObj.id} at ${new Date().toISOString()}`);
  
  // Safely extract values with default fallbacks
  const workorderid = requestObj?.id;
  const createdby = requestObj?.requester?.name || 'Unknown Requester';
  const mobile = requestObj?.requester?.mobile || 'N/A';
  const ictTechnician = requestObj?.udf_fields?.udf_pick_601 || null;
  const isUpdatedByBot = requestObj?.udf_fields?.udf_pick_902;
  const subject = requestObj?.subject;
  const ticketStatus = requestObj?.status?.name;
  const priority = requestObj?.priority?.name;

  if (!workorderid) {
    console.error('Invalid request object: Missing workorder ID');
    return;
  }

  // if (isUpdatedByBot === 'True') {
  //   console.log(`Ignoring update triggered by the bot for ticket ID: ${workorderid}`);
  //   return;
  // }

  const { notify_requester_assign, notify_requester_update, notify_technician } = payload;

  let previousState;
  try {
    previousState = await getPreviousTicketState(workorderid);
  } catch (error) {
    console.error(`Error fetching previous state for ticket ${workorderid}:`, error.message);
    return;
  }

  const previousTechnician = previousState?.technician || 'Unassigned';

  console.log('ICT Technician:', ictTechnician);
  console.log('Previous Technician:', previousTechnician);

  // Check if technician has changed
  const technicianChanged = previousTechnician !== ictTechnician && ictTechnician !== null;

  // Handle new assignment or reassignment of technician
  if (technicianChanged) {
    console.log(`Technician changed from ${previousTechnician} to ${ictTechnician} for ticket ${workorderid}`);
    await handleTechnicianChange(
      workorderid,
      ictTechnician,
      previousTechnician,
      createdby,
      subject,
      mobile,
      notify_requester_assign === 'true',
      notify_technician === 'true'
    );
    // Update Redis with the new technician state
    await storeCurrentTicketState(workorderid, { technician: ictTechnician });
  }
  else {
    console.log(`No technician change detected for ticket ${workorderid}. Skipping notifications.`);
  }

  // Generate a summary of changes
  const changes = generateChangeDetails({ 
    ictTechnician: ictTechnician || 'Unassigned',
    ticketStatus: ticketStatus || 'Unknown',
    priority: priority || 'Not Set'
  });

  // Construct the general update notification message
  const notificationMessage = `*Request update notification!*\n\n*Ticket No.:* ${workorderid}\n*Created by:* ${createdby}\n${changes}\n*Subject:* ${subject || 'No subject'}\n\n*Link:* [View Request](https://helpdesk.merdekabattery.com/WorkOrder.do?woMode=viewWO&woID=${workorderid}&PORTALID=1)`;

  // Notify the group/receiver
  try {
    await sock.sendMessage(receiver, { text: notificationMessage });
  } catch (error) {
    console.error(`Error sending notification message to receiver: ${error.message}`);
  }

  // Notify the requester for general updates if enabled
  if (notify_requester_update === 'true' && mobile !== 'N/A') {
    const requesterMessage = `Dear *${createdby}*,\n\nYour ticket \"${subject || 'No subject'}\" (ID: ${workorderid}) has been updated. Here are the details:\n\n${changes}\n\n*View your request here:*\nhttps://helpdesk.merdekabattery.com/WorkOrder.do?woMode=viewWO&woID=${workorderid}&PORTALID=1`;
    try {
      await sock.sendMessage(phoneNumberFormatter(mobile), { text: requesterMessage });
    } catch (error) {
      console.error(`Error sending notification to requester: ${error.message}`);
    }
  }

  // Store the updated state
  try {
    await storeCurrentTicketState(workorderid, {
      status: 'updated',
      ticketStatus: ticketStatus || 'Unknown',
      priority: priority || 'Not Set',
      technician: ictTechnician || 'Unassigned',
    });
  } catch (error) {
    console.error(`Error storing ticket state: ${error.message}`);
  }
};

const handleTechnicianChange = async (
  workorderid,
  newTechnicianName,
  previousTechnician,
  createdby,
  subject,
  mobile,
  notifyRequester,
  notifyTechnician
) => {
  // Notify the old technician if they exist and technician notifications are enabled
  if (previousTechnician !== 'Unassigned' && previousTechnician !== newTechnicianName && notifyTechnician) {
    try {
      const oldTechnician = await getContactByIctTechnicianName(previousTechnician);
      if (oldTechnician) {
        const message = `Dear *${oldTechnician.name}*,\n\nThe ticket with ID *${workorderid}* has been reassigned and is no longer under your responsibility.\n\n*Ticket Subject:* ${subject}`;
        await sock.sendMessage(phoneNumberFormatter(oldTechnician.phone), { text: message });
      }
    } catch (error) {
      console.error(`Error notifying old technician: ${error.message}`);
    }
  }

  // Notify and assign the new technician if enabled
  if (newTechnicianName && notifyTechnician) {
    try {
      const newTechnician = await getContactByIctTechnicianName(newTechnicianName);
      if (newTechnician) {
        const groupName = determineGroupByTechnician(newTechnician.technician);
        await assignTechnicianToRequest(workorderid, newTechnician.technician, groupName);
        // Store the current state of the ticket for the new technician
        await storeCurrentTicketState(workorderid, { technician: newTechnicianName });
        const message = `Dear *${newTechnician.name}*,\n\nYou have been assigned a new ticket:\n\n*Ticket ID:* ${workorderid}\n*Subject:* ${subject}\n*Created by:* ${createdby}\n\nPlease address this ticket as soon as possible.\n\n*View details:* [View Request](https://helpdesk.merdekabattery.com/WorkOrder.do?woMode=viewWO&woID=${workorderid}&PORTALID=1)`;
        await sock.sendMessage(phoneNumberFormatter(newTechnician.phone), { text: message });
      }
    } catch (error) {
      console.error(`Error notifying new technician: ${error.message}`);
    }
  }

  // Notify the requester if enabled
  if (notifyRequester && mobile !== 'N/A') {
    const message =
      previousTechnician === 'Unassigned'
        ? // New assignment
          `Dear *${createdby}*,\n\nYour ticket with subject: "${subject}" has been assigned to *${newTechnicianName}*. Please wait while our support team reaches out to you.\n\n*View your request here:*\nhttps://helpdesk.merdekabattery.com/WorkOrder.do?woMode=viewWO&woID=${workorderid}&PORTALID=1`
        : // Reassignment
          `Dear *${createdby}*,\n\nYour ticket with subject: "${subject}" has been reassigned from *${previousTechnician}* to *${newTechnicianName}*. Please wait while our support team reaches out to you.\n\n*View your request here:*\nhttps://helpdesk.merdekabattery.com/WorkOrder.do?woMode=viewWO&woID=${workorderid}&PORTALID=1`;

    await sock.sendMessage(phoneNumberFormatter(mobile), { text: message });
  }
};




// const handleTechnicianChange = async (workorderid, ictTechnician, previousState, createdby, subject, mobile) => {
//   try {
//       console.log(`Handling technician change for workorder ID: ${workorderid}, ICT Technician: ${ictTechnician}`);

//       const technician = await getContactByIctTechnicianName(ictTechnician);
//       if (!technician) {
//           console.error('Technician not found for ICT Technician:', ictTechnician);
//           throw new Error('Technician not found');
//       }

//       console.log('ICT Technician found:', technician);

//       const groupName = determineGroupByTechnician(technician.technician);
//       console.log(`Assigning technician to request. Group: ${groupName}, Technician: ${technician.technician}`);
//       await assignTechnicianToRequest(workorderid, technician.technician, groupName);

//       const reassignmentMessage = previousState
//           ? `Your ticket (ID: ${workorderid}) has been reassigned from *${previousState.technician}* to *${technician.name}*.`
//           : `Your ticket (ID: ${workorderid}) has been assigned to *${technician.name}*.`;

//       const requesterMessage = `Dear *${createdby}*,\n\n${reassignmentMessage}\n\n*Ticket Subject:* ${subject}\n\n*View details:* [View Request](https://helpdesk.merdekabattery.com:8080/WorkOrder.do?woMode=viewWO&woID=${workorderid}&PORTALID=1)`;

//       console.log('Sending message to requester:', requesterMessage);
//       await sock.sendMessage(phoneNumberFormatter(mobile), { text: requesterMessage });
      
      

//     } catch (error) {
//       console.error('Error handling technician change:', error.message);
//   }
// };

const determineGroupByTechnician = (technicianRole) => {
  if (technicianRole.includes('IT Support')) return 'ICT System and Support';
  if (technicianRole.includes('IT Field Support')) return 'ICT Network and Infrastructure';
  if (technicianRole.includes('Document Control')) return 'ICT Document Controller';
  throw new Error('Unrecognized technician role. Please ensure the technician role is valid.');
};

const generateTechnicianNotification = (workorderid, subject, technicianName) => {
    return `Dear *${technicianName}*,\n\nYou have been assigned a new ticket:\n\n*Ticket ID:* ${workorderid}\n*Subject:* ${subject}\n\nPlease address this ticket as soon as possible.\n\n*View details:* [View Request](https://helpdesk.merdekabattery.com/WorkOrder.do?woMode=viewWO&woID=${workorderid}&PORTALID=1)`;
};


const generateNotificationMessage = (createdby, createdDate, email, workorderid, subject, description) => {
  return `*New request from ${createdby} on ${createdDate}!*\n*Email:* ${email}\n*Ticket number:* ${workorderid}\n\n*Subject:* ${subject}\n*Description:* ${description}\n\n*For details, see the link below:*\nhttps://helpdesk.merdekabattery.com/WorkOrder.do?woMode=viewWO&woID=${workorderid}&PORTALID=1`;
};

const generateChangeDetails = ({ ictTechnician, ticketStatus, priority }) => {
  let changes = '';
  if (ictTechnician) changes += `*ICT Technician:* ${ictTechnician}\n`;
  if (ticketStatus) changes += `*Status:* ${ticketStatus}\n`;
  if (priority) changes += `*Priority:* ${priority}\n`;
  return changes;
};

// Handle exit events to save alarms before the process exits
const handleExit = (signal) => {
  console.log(`Received ${signal}. Saving alarms and exiting...`);
  saveAlarms();
  process.exit(0);
};

process.on('SIGINT', handleExit);
process.on('SIGTERM', handleExit);

// Initialize contact mapping system
initContactMapping();

// app.listen(PORT, () => {
//     console.log(`Server running on port ${PORT}`);
// });

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// Export for testing
export { isTagged };




