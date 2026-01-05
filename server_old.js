const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, downloadMediaMessage, fetchLatestBaileysVersion, Browsers } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const cors = require('cors');
const path = require('path');
const P = require('pino');
const { Client } = require('ldapts');
const LIDMappingManager = require('./lib/lidMapping');
require('dotenv').config();

const app = express();
const server = createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 8192;
let sock;
let qrDinamic;
let soket;

// Configuration
const ADMIN_NUMBER = '6285712612218'; // Changed from 6285712612218 to avoid conflict with other container
let who_i_am = null; // Will be set when connection is established
let who_i_am_lid = null; // Will store our LID for comparison

// LID Mapping Manager Instance
let lidMappingManager = null;

// n8n Integration Configuration
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL;
const N8N_ENABLED = process.env.N8N_ENABLED === 'true';
const N8N_TIMEOUT = parseInt(process.env.N8N_TIMEOUT) || 5000;

// LDAP Configuration
const LDAP_URL = process.env.LDAP_URL;
const LDAP_BIND_DN = process.env.LDAP_BIND_DN;
const LDAP_BIND_PASSWORD = process.env.LDAP_BIND_PASSWORD;
const LDAP_BASE_DN = process.env.LDAP_BASE_DN;
const LDAP_SEARCH_FILTER = process.env.LDAP_SEARCH_FILTER || '(telephoneNumber={phone})';
const LDAP_ENABLED = process.env.LDAP_ENABLED === 'true';
const LDAP_TIMEOUT = parseInt(process.env.LDAP_TIMEOUT) || 10000;
const LDAP_CONNECT_TIMEOUT = parseInt(process.env.LDAP_CONNECT_TIMEOUT) || 5000;
const LDAP_MAX_RETRIES = parseInt(process.env.LDAP_MAX_RETRIES) || 3;
const LDAP_RETRY_DELAY = parseInt(process.env.LDAP_RETRY_DELAY) || 1000;

// LDAP Connection Pool
let ldapClient = null;
let ldapConnectionPromise = null;
let lastLdapError = null;
let ldapReconnectAttempts = 0;
const MAX_LDAP_RECONNECT_ATTEMPTS = 5;

// Typing Indicator Configuration
const TYPING_ENABLED = process.env.TYPING_ENABLED === 'true';

// Message Buffering Configuration
const MESSAGE_BUFFER_ENABLED = process.env.MESSAGE_BUFFER_ENABLED === 'true';
const MESSAGE_BUFFER_TIMEOUT = parseInt(process.env.MESSAGE_BUFFER_TIMEOUT) || 3000;

// Presence-Based Buffering Configuration
const PRESENCE_BUFFER_ENABLED = process.env.PRESENCE_BUFFER_ENABLED === 'true';
const PRESENCE_BUFFER_MAX_TIMEOUT = parseInt(process.env.PRESENCE_BUFFER_MAX_TIMEOUT) || 10000;
const PRESENCE_BUFFER_STOP_DELAY = parseInt(process.env.PRESENCE_BUFFER_STOP_DELAY) || 2000;
const PRESENCE_SUBSCRIPTION_ENABLED = process.env.PRESENCE_SUBSCRIPTION_ENABLED === 'true';

// Message Buffer Storage
const messageBuffers = new Map(); // phoneNumber -> { messages: [], timer: timeoutId, lastMessageTime: timestamp, isTyping: boolean, typingTimer: timeoutId }
// Presence tracking storage
const presenceStatus = new Map(); // phoneNumber -> { isTyping: boolean, lastUpdate: timestamp }

// Forward declarations for message processing functions
let processMessageForReply;
let processMessageForLogging;
let sendDefaultReply;

// Presence Detection Functions
function subscribeToPresence(phoneNumber) {
  if (!PRESENCE_SUBSCRIPTION_ENABLED || !sock) {
    return;
  }
  
  try {
    const jid = phoneNumber.includes('@') ? phoneNumber : `${phoneNumber}@s.whatsapp.net`;
    sock.presenceSubscribe(jid);
    console.log(`📡 Subscribed to presence for ${phoneNumber}`);
  } catch (error) {
    console.error(`❌ Failed to subscribe to presence for ${phoneNumber}:`, error.message);
  }
}

function handlePresenceUpdate(phoneNumber, presence) {
  if (!PRESENCE_BUFFER_ENABLED) {
    return;
  }
  
  const isTyping = presence === 'composing';
  const now = Date.now();
  
  // Update presence status
  presenceStatus.set(phoneNumber, {
    isTyping,
    lastUpdate: now
  });
  
  console.log(`👤 Presence update for ${phoneNumber}: ${presence} (typing: ${isTyping})`);
  
  // If user has a message buffer, update typing status
  const buffer = messageBuffers.get(phoneNumber);
  if (buffer) {
    buffer.isTyping = isTyping;
    
    if (isTyping) {
      // User started typing - extend the buffer timeout
      if (buffer.timer) {
        clearTimeout(buffer.timer);
      }
      if (buffer.typingTimer) {
        clearTimeout(buffer.typingTimer);
      }
      
      // Set maximum timeout as fallback
      buffer.timer = setTimeout(() => {
        console.log(`⏰ Max timeout reached for ${phoneNumber}, flushing buffer`);
        flushMessageBuffer(phoneNumber);
      }, PRESENCE_BUFFER_MAX_TIMEOUT);
      
    } else {
      // User stopped typing - set delay before processing
      if (buffer.typingTimer) {
        clearTimeout(buffer.typingTimer);
      }
      
      buffer.typingTimer = setTimeout(() => {
        console.log(`✋ User stopped typing for ${phoneNumber}, flushing buffer after delay`);
        flushMessageBuffer(phoneNumber);
      }, PRESENCE_BUFFER_STOP_DELAY);
    }
  }
}

// Message Buffering Functions
function addToMessageBuffer(phoneNumber, messageData) {
  if (!MESSAGE_BUFFER_ENABLED) {
    return false; // Don't buffer if disabled
  }

  const now = Date.now();
  
  if (!messageBuffers.has(phoneNumber)) {
    // Create new buffer for this phone number
    messageBuffers.set(phoneNumber, {
      messages: [],
      timer: null,
      typingTimer: null,
      lastMessageTime: now,
      isTyping: false
    });
    
    // Subscribe to presence updates for this user
    subscribeToPresence(phoneNumber);
  }

  const buffer = messageBuffers.get(phoneNumber);
  
  // Add message to buffer
  buffer.messages.push(messageData);
  buffer.lastMessageTime = now;
  
  // Clear existing timers
  if (buffer.timer) {
    clearTimeout(buffer.timer);
  }
  if (buffer.typingTimer) {
    clearTimeout(buffer.typingTimer);
  }
  
  // Check if presence-based buffering is enabled
  if (PRESENCE_BUFFER_ENABLED) {
    // Check current typing status
    const currentPresence = presenceStatus.get(phoneNumber);
    const isCurrentlyTyping = currentPresence?.isTyping || false;
    
    if (isCurrentlyTyping) {
      // User is typing, wait for them to stop (with max timeout as fallback)
      console.log(`⌨️ User ${phoneNumber} is typing, waiting for them to finish...`);
      buffer.timer = setTimeout(() => {
        console.log(`⏰ Max timeout reached for ${phoneNumber}, flushing buffer`);
        flushMessageBuffer(phoneNumber);
      }, PRESENCE_BUFFER_MAX_TIMEOUT);
    } else {
      // User not typing, use shorter delay to allow for quick follow-up messages
      buffer.timer = setTimeout(() => {
        flushMessageBuffer(phoneNumber);
      }, PRESENCE_BUFFER_STOP_DELAY);
    }
  } else {
    // Fallback to traditional timeout-based buffering
    buffer.timer = setTimeout(() => {
      flushMessageBuffer(phoneNumber);
    }, MESSAGE_BUFFER_TIMEOUT);
  }
  
  return true; // Message was buffered
}

function flushMessageBuffer(phoneNumber) {
  const buffer = messageBuffers.get(phoneNumber);
  if (!buffer || buffer.messages.length === 0) {
    return;
  }
  
  // Combine all messages with newline separators
  const combinedMessage = buffer.messages.map(msg => msg.message).join('\n');
  
  // Check if combined message is a command before processing
  if (combinedMessage && /^\//.test(combinedMessage.trim())) {
    console.log('Skipping n8n processing for buffered chatbot command:', combinedMessage.trim());
    // Clear the buffer and timers
    if (buffer.timer) {
      clearTimeout(buffer.timer);
    }
    if (buffer.typingTimer) {
      clearTimeout(buffer.typingTimer);
    }
    messageBuffers.delete(phoneNumber);
    return; // Skip processing for commands
  }
  
  // Create combined message data using the first message as template
  const firstMessage = buffer.messages[0];
  const combinedData = {
    ...firstMessage,
    message: combinedMessage,
    messageCount: buffer.messages.length,
    isBufferedMessage: true,
    bufferDuration: Date.now() - buffer.lastMessageTime,
    wasTypingDetected: buffer.isTyping
  };
  
  // Clear the buffer and all timers
  if (buffer.timer) {
    clearTimeout(buffer.timer);
  }
  if (buffer.typingTimer) {
    clearTimeout(buffer.typingTimer);
  }
  messageBuffers.delete(phoneNumber);
  
  // Process combined message based on whether it should reply
  const bufferType = PRESENCE_BUFFER_ENABLED ? 'presence-aware' : 'timeout-based';
  console.log(`📤 Flushing ${bufferType} buffered messages for ${phoneNumber}: ${buffer.messages.length} messages combined`);
  
  if (combinedData.shouldReply) {
    // Use the processMessageForReply function (need to make it accessible)
    processMessageForReply(combinedData).catch(error => {
      console.error('Error processing buffered message for reply:', error.message);
    });
  } else {
    // If shouldReply is false, skip all processing including n8n logging
    console.log(`Skipping n8n processing for buffered message (shouldReply=false): ${phoneNumber}`);
    // No processing needed when shouldReply is false
  }
}

// n8n Webhook Function with Enhanced Error Handling
async function sendToN8N(data) {
  if (!N8N_ENABLED) {
    console.log('n8n integration is disabled');
    return { success: false, reason: 'disabled' };
  }

  if (!N8N_WEBHOOK_URL) {
    console.warn('n8n webhook URL not configured in environment variables');
    return { success: false, reason: 'no_url' };
  }

  // Enhanced WhatsApp connection check before sending to n8n
  const connectionStatus = isWhatsAppConnected();
  if (!connectionStatus.connected) {
    console.log('⚠️ WhatsApp not connected. Connection status:', connectionStatus);
    console.log('⚠️ Skipping n8n webhook for message:', data.messageId || 'unknown');
    return { success: false, reason: connectionStatus.reason, details: connectionStatus.details };
  }

  const startTime = Date.now();
  
  try {
    console.log(`Sending data to n8n webhook: ${N8N_WEBHOOK_URL}`);
    
    // For HTTPS URLs with SSL issues, use https module directly
    if (N8N_WEBHOOK_URL.startsWith('https://')) {
      const https = require('https');
      const url = require('url');
      
      const parsedUrl = new url.URL(N8N_WEBHOOK_URL);
      const postData = JSON.stringify(data);
      
      const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || 443,
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData),
          'User-Agent': 'WhatsApp-AI-Bot/1.0',
          ...(process.env.N8N_API_KEY && { 'Authorization': `Bearer ${process.env.N8N_API_KEY}` })
        },
        rejectUnauthorized: false, // Ignore SSL certificate validation errors
        timeout: N8N_TIMEOUT
      };
      
      return new Promise((resolve) => {
        const req = https.request(options, (res) => {
          let responseData = '';
          
          res.on('data', (chunk) => {
            responseData += chunk;
          });
          
          res.on('end', () => {
            const duration = Date.now() - startTime;
            
            if (res.statusCode >= 200 && res.statusCode < 300) {
              console.log(`Successfully sent data to n8n webhook in ${duration}ms`);
              try {
                const result = JSON.parse(responseData);
                resolve({ success: true, duration, result });
              } catch {
                resolve({ success: true, duration, result: { success: true } });
              }
            } else {
              console.error(`n8n webhook failed [${res.statusCode}] in ${duration}ms:`, {
                status: res.statusCode,
                statusText: res.statusMessage,
                url: N8N_WEBHOOK_URL,
                error: responseData
              });
              resolve({ success: false, error: `HTTP ${res.statusCode}: ${res.statusMessage}`, duration });
            }
          });
        });
        
        req.on('error', (error) => {
          const duration = Date.now() - startTime;
          console.error('n8n webhook HTTPS request error:', {
            url: N8N_WEBHOOK_URL,
            error: error.message,
            messageId: data.messageId
          });
          resolve({ success: false, error: error.message, duration });
        });
        
        req.on('timeout', () => {
          const duration = Date.now() - startTime;
          console.error(`n8n webhook timeout after ${N8N_TIMEOUT}ms:`, {
            url: N8N_WEBHOOK_URL,
            timeout: N8N_TIMEOUT,
            messageId: data.messageId
          });
          req.destroy();
          resolve({ success: false, error: 'Request timeout', duration });
        });
        
        req.write(postData);
        req.end();
      });
    }
    
    // For HTTP URLs, use fetch as before
    const fetchOptions = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'WhatsApp-AI-Bot/1.0',
        ...(process.env.N8N_API_KEY && { 'Authorization': `Bearer ${process.env.N8N_API_KEY}` })
      },
      body: JSON.stringify(data),
      signal: AbortSignal.timeout(N8N_TIMEOUT)
    };
    
    const response = await fetch(N8N_WEBHOOK_URL, fetchOptions);

    const duration = Date.now() - startTime;
    
    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unable to read error response');
      console.error(`n8n webhook failed [${response.status}] in ${duration}ms:`, {
        status: response.status,
        statusText: response.statusText,
        url: N8N_WEBHOOK_URL,
        error: errorText
      });
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const result = await response.json().catch(() => ({ success: true }));
    console.log(`Successfully sent data to n8n webhook in ${duration}ms`);
    
    return { success: true, duration, result };
    
  } catch (error) {
    const duration = Date.now() - startTime;
    
    if (error.name === 'TimeoutError') {
      console.error(`n8n webhook timeout after ${N8N_TIMEOUT}ms:`, {
        url: N8N_WEBHOOK_URL,
        timeout: N8N_TIMEOUT,
        messageId: data.messageId
      });
    } else if (error.name === 'TypeError' && error.message.includes('fetch')) {
      console.error('n8n webhook network error:', {
        url: N8N_WEBHOOK_URL,
        error: error.message,
        messageId: data.messageId
      });
    } else {
      console.error(`n8n webhook error in ${duration}ms:`, {
        error: error.message,
        url: N8N_WEBHOOK_URL,
        messageId: data.messageId
      });
    }
    
    return { success: false, error: error.message, duration };
  }
}

// Message Processing Functions
processMessageForReply = async function(data) {
  try {
    // Search for user in Active Directory with push name detection
    const adUserInfo = await searchUserInAD(data.fromNumber, data.pushName);
    
    // Check if message should be skipped (LDAP failed without push name fallback)
    if (adUserInfo && adUserInfo.shouldSkipN8n) {
      console.log('Skipping n8n webhook due to LDAP failure without push name fallback');
      return { success: false, reason: 'ldap_failed_no_pushname' };
    }
    
    const webhookData = {
      ...data,
      adUser: adUserInfo // Add Active Directory user information
    };
    
    console.log('Sending message to n8n for response...');
    const n8nResult = await sendToN8N(webhookData);
    
    if (n8nResult.success && n8nResult.result) {
      // Extract response from n8n
      let replyText = null;
      
      // Handle different n8n response formats
       if (Array.isArray(n8nResult.result) && n8nResult.result.length > 0) {
         // Format: [{ "output": "response text" }]
         replyText = n8nResult.result[0].output || n8nResult.result[0].message || n8nResult.result[0].text || n8nResult.result[0].reply;
       } else if (n8nResult.result.reply) {
         // Format: { "reply": "response text" } - n8n specific format
         replyText = n8nResult.result.reply;
       } else if (n8nResult.result.output) {
         // Format: { "output": "response text" }
         replyText = n8nResult.result.output;
       } else if (n8nResult.result.message) {
         // Format: { "message": "response text" }
         replyText = n8nResult.result.message;
       } else if (typeof n8nResult.result === 'string') {
         // Format: "response text"
         replyText = n8nResult.result;
       }
      
      if (replyText) {
        // Show typing indicator before sending reply (if enabled)
        if (TYPING_ENABLED) {
          try {
            await sock.sendPresenceUpdate('composing', data.replyTo);
            console.log('Showing typing indicator to:', data.isGroup ? 'group' : data.fromNumber);
            
            // Wait a moment to simulate natural typing
            await new Promise(resolve => setTimeout(resolve, 1500));
            
            // Send the actual reply
            await sock.sendMessage(data.replyTo, { text: replyText });
            
            // Mark as available after sending
            await sock.sendPresenceUpdate('available', data.replyTo);
            
            console.log('Sent n8n response to:', data.isGroup ? 'group' : data.fromNumber);
          } catch (presenceError) {
            console.error('Error with presence update:', presenceError.message);
            // Still send the message even if presence update fails
            await sock.sendMessage(data.replyTo, { text: replyText });
            console.log('Sent n8n response to:', data.isGroup ? 'group' : data.fromNumber, '(without typing indicator)');
          }
        } else {
          // Send reply directly without typing indicator
          await sock.sendMessage(data.replyTo, { text: replyText });
          console.log('Sent n8n response to:', data.isGroup ? 'group' : data.fromNumber, '(typing disabled)');
        }
      } else {
        console.log('No valid response text found in n8n result:', n8nResult.result);
        // Fallback to default reply
        await sendDefaultReply(data.replyTo, data.isGroup);
      }
    } else {
      console.log('n8n request failed, using default reply');
      // Fallback to default reply
      await sendDefaultReply(data.replyTo, data.isGroup);
    }
  } catch (error) {
    console.error('Error processing n8n response:', error.message);
    // Fallback to default reply
    await sendDefaultReply(data.replyTo, data.isGroup);
  }
};

processMessageForLogging = async function(data) {
  try {
    // Search for user in Active Directory with push name detection
    const adUserInfo = await searchUserInAD(data.fromNumber, data.pushName);
    
    // Check if message should be skipped (LDAP failed without push name fallback)
    if (adUserInfo && adUserInfo.shouldSkipN8n) {
      console.log('Skipping n8n webhook logging due to LDAP failure without push name fallback');
      return;
    }
    
    const webhookData = {
      ...data,
      adUser: adUserInfo, // Add Active Directory user information
      shouldReply: false // Indicate this is just for logging
    };
    
    // Send to n8n webhook (non-blocking for logging)
    sendToN8N(webhookData).catch(error => {
      console.error('Failed to send message to n8n for logging:', error.message);
    });
  } catch (error) {
    console.error('Error preparing data for n8n webhook:', error.message);
  }
};

sendDefaultReply = async function(recipient, isGroupMessage) {
  try {
    // Enhanced WhatsApp connection check before sending default reply
    const connectionStatus = isWhatsAppConnected();
    if (!connectionStatus.connected) {
      console.log('⚠️ WhatsApp not connected. Connection status:', connectionStatus);
      console.log('⚠️ Skipping default reply to:', recipient);
      return;
    }
    
    // Show typing indicator before sending default reply (if enabled)
    if (TYPING_ENABLED) {
      try {
        await sock.sendPresenceUpdate('composing', recipient);
        console.log('Showing typing indicator for default reply to:', recipient);
        
        // Wait a moment to simulate natural typing
        await new Promise(resolve => setTimeout(resolve, 1000));
      } catch (presenceError) {
        console.error('Error with presence update for default reply:', presenceError.message);
        // Don't fail the entire function for presence errors
      }
    }
    
    const messageText = isGroupMessage 
      ? 'Currently, AI system is not available, please wait. 🤖'
      : 'Currently, AI system is not available, please wait. 🤖\n\nPlease try again later.';
    
    await sock.sendMessage(recipient, { text: messageText });
    console.log(`✅ Sent default ${isGroupMessage ? 'group' : 'direct'} reply to:`, recipient, TYPING_ENABLED ? '' : '(typing disabled)');
    
    // Mark as available after sending (if typing was enabled)
    if (TYPING_ENABLED) {
      try {
        await sock.sendPresenceUpdate('available', recipient);
      } catch (presenceError) {
        console.error('Error setting available status after default reply:', presenceError.message);
      }
    }
  } catch (error) {
    const errorMessage = error.message || 'Unknown error';
    
    if (errorMessage.includes('Connection Closed') || errorMessage.includes('Stream Errored')) {
      console.log('🔴 Cannot send default reply - WhatsApp connection lost:', errorMessage);
    } else if (error.output?.statusCode === 428) {
      console.log('🟡 Cannot send default reply - Connection precondition failed (428)');
    } else {
      console.error('❌ Error sending default reply:', error);
    }
  }
};

// Media Processing Functions

// Process individual media attachment with support for multiple files
async function processMediaAttachment(message, mediaType, mediaMessage) {
  try {
    let mediaData = null;
    let attachment = {
      type: mediaType,
      caption: mediaMessage.caption || '',
      mimetype: mediaMessage.mimetype || getDefaultMimetype(mediaType),
      fileLength: mediaMessage.fileLength || 0,
      fileName: mediaMessage.fileName || null,
      error: null
    };

    // Download media data
    try {
      const mediaBuffer = await downloadMediaMessage(message, 'buffer', {});
      mediaData = mediaBuffer ? mediaBuffer.toString('base64') : null;
      
      // Add type-specific properties
      switch (mediaType) {
        case 'image':
          attachment.imageData = mediaData;
          attachment.width = mediaMessage.width || null;
          attachment.height = mediaMessage.height || null;
          break;
        case 'video':
          attachment.videoData = mediaData;
          attachment.seconds = mediaMessage.seconds || 0;
          attachment.width = mediaMessage.width || null;
          attachment.height = mediaMessage.height || null;
          break;
        case 'audio':
          attachment.audioData = mediaData;
          attachment.seconds = mediaMessage.seconds || 0;
          attachment.ptt = mediaMessage.ptt || false;
          break;
        case 'document':
          attachment.documentData = mediaData;
          attachment.fileName = mediaMessage.fileName || 'Unknown file';
          break;
      }
      
      // Media downloaded successfully
    } catch (downloadError) {
      console.error(`Error downloading ${mediaType}:`, downloadError);
      attachment.error = `Failed to download ${mediaType}`;
    }
    
    return attachment;
  } catch (error) {
    console.error(`Error processing ${mediaType} attachment:`, error);
    return {
      type: mediaType,
      error: `Failed to process ${mediaType}`,
      caption: mediaMessage.caption || '',
      mimetype: mediaMessage.mimetype || getDefaultMimetype(mediaType),
      fileLength: mediaMessage.fileLength || 0
    };
  }
}

// Get default mimetype for media type
function getDefaultMimetype(mediaType) {
  const defaults = {
    image: 'image/jpeg',
    video: 'video/mp4',
    audio: 'audio/ogg',
    document: 'application/octet-stream'
  };
  return defaults[mediaType] || 'application/octet-stream';
}

// LDAP Functions for Active Directory Integration

// Initialize LDAP connection with retry logic
async function initializeLdapConnection() {
  if (ldapConnectionPromise) {
    return ldapConnectionPromise;
  }

  ldapConnectionPromise = (async () => {
    try {
      if (ldapClient) {
        try {
          await ldapClient.unbind();
        } catch (e) {
          // Ignore unbind errors
        }
      }

      ldapClient = new Client({
        url: LDAP_URL,
        timeout: LDAP_TIMEOUT,
        connectTimeout: LDAP_CONNECT_TIMEOUT,
      });

      await ldapClient.bind(LDAP_BIND_DN, LDAP_BIND_PASSWORD);
      console.log('LDAP connection established successfully');
      ldapReconnectAttempts = 0;
      lastLdapError = null;
      return ldapClient;
    } catch (error) {
      console.error('LDAP connection failed:', error.message);
      ldapClient = null;
      ldapConnectionPromise = null;
      lastLdapError = error;
      throw error;
    }
  })();

  return ldapConnectionPromise;
}

// Get or create LDAP connection
async function getLdapConnection() {
  if (ldapClient && lastLdapError === null) {
    return ldapClient;
  }

  if (ldapReconnectAttempts >= MAX_LDAP_RECONNECT_ATTEMPTS) {
    throw new Error(`LDAP connection failed after ${MAX_LDAP_RECONNECT_ATTEMPTS} attempts. Last error: ${lastLdapError?.message}`);
  }

  ldapReconnectAttempts++;
  return await initializeLdapConnection();
}

// Search user with retry logic and push name detection
async function searchUserInAD(phoneNumber, pushName = null) {
  if (!LDAP_ENABLED || !LDAP_URL || !phoneNumber) {
    // If user has push name but no AD integration, return push name user with undefined gender
    if (pushName) {
      return {
        found: false,
        isPushNameOnly: true,
        name: pushName,
        gender: undefined, // Set gender to undefined for push name only users
        status: 'User exists only as push name (not in Active Directory)', // Changed from 'message' to 'status'
        searchedPhone: phoneNumber,
        timestamp: new Date().toISOString()
      };
    }
    return null;
  }

  let lastError = null;
  
  for (let attempt = 1; attempt <= LDAP_MAX_RETRIES; attempt++) {
    try {
      const client = await getLdapConnection();
      
      // Clean phone number (remove + and spaces)
      const cleanPhone = phoneNumber.replace(/[+\s-]/g, '');
      
      // Create search filter
      const searchFilter = LDAP_SEARCH_FILTER.replace('{phone}', cleanPhone);
      
      // Search for user
      const searchOptions = {
        scope: 'sub',
        filter: searchFilter,
        attributes: [
          'displayName', 'department', 'gender', 'mail', 'title', 
          'telephoneNumber', 'mobile', 'company', 'manager', 
          'employeeID', 'sAMAccountName', 'userPrincipalName'
        ]
      };
      
      const searchResult = await client.search(LDAP_BASE_DN, searchOptions);
      
      if (searchResult.searchEntries && searchResult.searchEntries.length > 0) {
        const user = searchResult.searchEntries[0];
        return {
          found: true,
          isPushNameOnly: false,
          name: user.displayName,
          gender: user.gender,
          email: user.mail,
          department: user.department,
          title: user.title,
          telephoneNumber: user.telephoneNumber,
          mobile: user.mobile,
          company: user.company,
          manager: user.manager,
          employeeID: user.employeeID,
          username: user.sAMAccountName,
          userPrincipalName: user.userPrincipalName,
          searchedPhone: phoneNumber,
          timestamp: new Date().toISOString()
        };
      }
      
      // User not found in AD, but has push name - return push name user with undefined gender
      if (pushName) {
        return {
          found: false,
          isPushNameOnly: true,
          name: pushName,
          gender: undefined, // Set gender to undefined for push name only users
          status: 'User exists only as push name (not in Active Directory)', // Changed from 'message' to 'status'
          searchedPhone: phoneNumber,
          timestamp: new Date().toISOString()
        };
      }
      
      return { found: false, status: 'User not found in Active Directory' }; // Changed from 'message' to 'status'
      
    } catch (error) {
      lastError = error;
      console.error(`LDAP search error (attempt ${attempt}/${LDAP_MAX_RETRIES}):`, {
        phone: phoneNumber,
        error: error.message,
        timestamp: new Date().toISOString(),
        attempt: attempt
      });
      
      // Reset connection on error
      ldapClient = null;
      ldapConnectionPromise = null;
      lastLdapError = error;
      
      // Wait before retry (except on last attempt)
      if (attempt < LDAP_MAX_RETRIES) {
        await new Promise(resolve => setTimeout(resolve, LDAP_RETRY_DELAY * attempt));
      }
    }
  }
  
  // All LDAP attempts failed - fallback to push name if available
  if (pushName) {
    console.log(`LDAP failed after ${LDAP_MAX_RETRIES} attempts, using push name fallback: ${pushName}`);
    return {
      found: false,
      isPushNameOnly: true,
      name: pushName,
      gender: undefined,
      status: 'User exists only as push name (not in Active Directory)', // Changed from 'message' to 'status'
      searchedPhone: phoneNumber,
      timestamp: new Date().toISOString()
    };
  }
  
  // No push name available - return error (this should NOT be sent to n8n)
  return { 
    found: false, 
    error: lastError?.message || 'Unknown LDAP error',
    message: `Error searching Active Directory after ${LDAP_MAX_RETRIES} attempts`,
    shouldSkipN8n: true // Flag to indicate this message should not be sent to n8n
  };
}

// Cleanup LDAP connection on shutdown
process.on('SIGTERM', async () => {
  if (ldapClient) {
    try {
      await ldapClient.unbind();
      console.log('LDAP connection closed gracefully');
    } catch (error) {
      console.error('Error closing LDAP connection:', error.message);
    }
  }
});

// Function to convert LID to phone number (using LID Mapping Manager)
function lidToPhoneNumber(lid) {
  if (!lidMappingManager) {
    console.warn('LID Mapping Manager not initialized, using fallback');
    return lid ? lid.split('@')[0] : null;
  }
  return lidMappingManager.lidToPhoneNumber(lid);
}

// Function to update LID mapping from contact info (using LID Mapping Manager)
function updateLidMapping(contacts) {
  if (!lidMappingManager) {
    console.warn('LID Mapping Manager not initialized, skipping contact update');
    return;
  }
  lidMappingManager.updateContactMappings(contacts);
}

// Enhanced WhatsApp connection status checker
function isWhatsAppConnected() {
  if (!sock) {
    return {
      connected: false,
      reason: 'socket_not_initialized',
      details: { sock: false, wsReady: false, hasUser: false, canSend: false }
    };
  }
  
  const wsReady = sock.ws?.readyState === 1;
  const hasUser = sock.user && sock.user.id;
  const canSend = typeof sock.sendMessage === 'function';
  
  // More lenient connection check: if user is authenticated and can send messages,
  // consider it connected even if WebSocket state is temporarily inconsistent
  const connected = hasUser && canSend && (wsReady || sock.ws?.readyState === undefined);
  
  return {
    connected,
    reason: connected ? (wsReady ? 'fully_connected' : 'functionally_connected') : 'partial_connection',
    details: {
      sock: true,
      wsReady,
      hasUser: !!hasUser,
      canSend,
      wsState: sock.ws?.readyState,
      userId: hasUser ? sock.user.id : null
    }
  };
}

// Function to check if a LID belongs to our API number (using LID Mapping Manager)
function isOurApiNumber(lid) {
  if (!lid || !who_i_am) {
    console.log(`🔍 isOurApiNumber: Invalid input - lid: ${lid}, who_i_am: ${who_i_am}`);
    return false;
  }
  
  console.log(`🔍 isOurApiNumber: Checking if ${lid} belongs to our API`);
  console.log(`🔍 Current bot values: who_i_am=${who_i_am}, who_i_am_lid=${who_i_am_lid}`);
  
  const cleanLid = lid.split('@')[0];
  
  // Extract base phone number from our bot's ID (remove device suffix like :66)
  const ourBasePhone = who_i_am ? who_i_am.split(':')[0] : null;
  const ourLidBase = who_i_am_lid ? who_i_am_lid.split(':')[0] : null;
  
  console.log(`🔍 Base phone numbers: ourBasePhone=${ourBasePhone}, ourLidBase=${ourLidBase}`);
  
  // Check direct matches first
  if (cleanLid === who_i_am || cleanLid === who_i_am_lid) {
    console.log(`🔍 Direct match found: ${cleanLid}`);
    return true;
  }
  
  // Check base phone number matches (without device suffix)
  if (ourBasePhone && cleanLid === ourBasePhone) {
    console.log(`🔍 Base phone match found: ${cleanLid} matches ${ourBasePhone}`);
    return true;
  }
  
  if (ourLidBase && cleanLid === ourLidBase) {
    console.log(`🔍 Base LID match found: ${cleanLid} matches ${ourLidBase}`);
    return true;
  }
  
  // Use LID mapping manager if available
  if (lidMappingManager) {
    const result = lidMappingManager.isPhoneNumber(lid, who_i_am);
    console.log(`🔍 LID Manager result: LID ${lid} belongs to our API number ${who_i_am}: ${result}`);
    if (result) return true;
    
    // Also check with base phone number
    if (ourBasePhone) {
      const baseResult = lidMappingManager.isPhoneNumber(lid, ourBasePhone);
      console.log(`🔍 LID Manager base result: LID ${lid} belongs to base number ${ourBasePhone}: ${baseResult}`);
      if (baseResult) return true;
    }
  }
  
  console.log(`🔍 No match found for ${lid}`);
  return false;
}

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// Serve the HTML file
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// API Routes
app.get('/api/status', (req, res) => {
  const connectionStatus = isWhatsAppConnected();
  const status = connectionStatus.connected ? 'connected' : 'disconnected';
  
  res.json({ 
    status, 
    qr: qrDinamic,
    connectionDetails: connectionStatus,
    user: sock?.user ? {
      id: sock.user.id,
      name: sock.user.name
    } : null,
    timestamp: new Date().toISOString()
  });
});

app.post('/api/send-message', async (req, res) => {
  try {
    const { number, message } = req.body;
    
    if (!sock) {
      return res.status(400).json({ error: 'WhatsApp not connected' });
    }
    
    if (!number || !message) {
      return res.status(400).json({ error: 'Number and message are required' });
    }
    
    const formattedNumber = number.includes('@s.whatsapp.net') ? number : `${number}@s.whatsapp.net`;
    
    await sock.sendMessage(formattedNumber, { text: message });
    res.json({ success: true, status: 'Message sent successfully' }); // Changed from 'message' to 'status'
  } catch (error) {
    console.error('Error sending message:', error);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

app.post('/api/send-groupmessage', async (req, res) => {
  try {
    const { groupId, message } = req.body;
    
    if (!sock) {
      return res.status(400).json({ error: 'WhatsApp not connected' });
    }
    
    if (!groupId || !message) {
      return res.status(400).json({ error: 'Group ID/name and message are required' });
    }
    
    let targetGroupId = groupId;
    
    // If groupId doesn't contain @g.us and is not numeric, treat it as group name
    if (!groupId.includes('@g.us') && isNaN(groupId)) {
      // Search for group by name
      const groups = await sock.groupFetchAllParticipating();
      const groupEntries = Object.entries(groups);
      
      const foundGroup = groupEntries.find(([id, group]) => 
        group.subject && group.subject.toLowerCase().includes(groupId.toLowerCase())
      );
      
      if (!foundGroup) {
        return res.status(404).json({ error: `Group with name '${groupId}' not found` });
      }
      
      targetGroupId = foundGroup[0]; // Use the found group ID
    } else {
      // Format group ID - groups use @g.us suffix
      targetGroupId = groupId.includes('@g.us') ? groupId : `${groupId}@g.us`;
    }
    
    await sock.sendMessage(targetGroupId, { text: message });
    res.json({ 
      success: true, 
      status: 'Group message sent successfully', // Changed from 'message' to 'status'
      groupId: targetGroupId
    });
  } catch (error) {
    console.error('Error sending group message:', error);
    res.status(500).json({ error: 'Failed to send group message' });
  }
});

// LID Mapping API Endpoints
app.get('/api/lid/stats', (req, res) => {
  try {
    if (!lidMappingManager) {
      return res.status(503).json({ error: 'LID Mapping Manager not initialized' });
    }
    
    const stats = lidMappingManager.getStats();
    res.json({ success: true, stats });
  } catch (error) {
    console.error('Error getting LID stats:', error);
    res.status(500).json({ error: 'Failed to get LID mapping statistics' });
  }
});

app.get('/api/lid/contacts', (req, res) => {
  try {
    if (!lidMappingManager) {
      return res.status(503).json({ error: 'LID Mapping Manager not initialized' });
    }
    
    const { search, type } = req.query;
    let contacts;
    
    if (search && type === 'phone') {
      contacts = lidMappingManager.searchByPhoneNumber(search);
    } else if (search && type === 'name') {
      contacts = lidMappingManager.searchByPushName(search);
    } else {
      contacts = lidMappingManager.getAllContacts();
    }
    
    res.json({ success: true, contacts, total: contacts.length });
  } catch (error) {
    console.error('Error getting contacts:', error);
    res.status(500).json({ error: 'Failed to get contacts' });
  }
});

app.get('/api/lid/contact/:id', (req, res) => {
  try {
    if (!lidMappingManager) {
      return res.status(503).json({ error: 'LID Mapping Manager not initialized' });
    }
    
    const { id } = req.params;
    const contact = lidMappingManager.getContactInfo(id);
    
    if (!contact) {
      return res.status(404).json({ error: 'Contact not found' });
    }
    
    res.json({ success: true, contact });
  } catch (error) {
    console.error('Error getting contact:', error);
    res.status(500).json({ error: 'Failed to get contact information' });
  }
});

app.post('/api/lid/scan', async (req, res) => {
  try {
    if (!lidMappingManager) {
      return res.status(503).json({ error: 'LID Mapping Manager not initialized' });
    }
    
    // Start async scan
    lidMappingManager.scanAllChats().then(() => {
      console.log('✅ Manual chat scan completed');
    }).catch(error => {
      console.error('❌ Error during manual chat scan:', error);
    });
    
    res.json({ success: true, status: 'Chat scan started. Check logs for progress.' }); // Changed from 'message' to 'status'
  } catch (error) {
    console.error('Error starting chat scan:', error);
    res.status(500).json({ error: 'Failed to start chat scan' });
  }
});

app.post('/api/lid/export', async (req, res) => {
  try {
    if (!lidMappingManager) {
      return res.status(503).json({ error: 'LID Mapping Manager not initialized' });
    }
    
    const { format = 'json' } = req.body;
    await lidMappingManager.exportContacts(format);
    
    res.json({ success: true, message: `Contacts exported in ${format} format` });
  } catch (error) {
    console.error('Error exporting contacts:', error);
    res.status(500).json({ error: 'Failed to export contacts' });
  }
});

// LDAP API Endpoints
app.get('/api/ldap-users', async (req, res) => {
  try {
    if (!LDAP_ENABLED) {
      return res.status(503).json({ error: 'LDAP is not enabled' });
    }

    // Test LDAP connection first
    try {
      await getLdapConnection();
    } catch (error) {
      return res.status(503).json({ 
        error: 'LDAP connection failed', 
        details: error.message 
      });
    }

    res.json({ 
      success: true, 
      status: 'LDAP connection available',
      config: {
        url: LDAP_URL,
        baseDN: LDAP_BASE_DN,
        enabled: LDAP_ENABLED
      }
    });
  } catch (error) {
    console.error('Error in LDAP users endpoint:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/ldap-users/test-connection', async (req, res) => {
  try {
    if (!LDAP_ENABLED) {
      return res.status(503).json({ 
        success: false, 
        error: 'LDAP is not enabled',
        config: { enabled: false }
      });
    }

    // Test LDAP connection
    try {
      const client = await getLdapConnection();
      
      // Perform a simple search to verify connection works
      const searchOptions = {
        scope: 'base',
        filter: '(objectClass=*)',
        attributes: ['objectClass']
      };
      
      await client.search(LDAP_BASE_DN, searchOptions);
      
      res.json({ 
        success: true, 
        status: 'LDAP connection successful',
        config: {
          url: LDAP_URL,
          baseDN: LDAP_BASE_DN,
          enabled: LDAP_ENABLED,
          timeout: LDAP_TIMEOUT,
          maxRetries: LDAP_MAX_RETRIES
        }
      });
    } catch (error) {
      console.error('LDAP connection test failed:', error);
      res.status(503).json({ 
        success: false, 
        error: 'LDAP connection test failed', 
        details: error.message,
        config: {
          url: LDAP_URL,
          baseDN: LDAP_BASE_DN,
          enabled: LDAP_ENABLED
        }
      });
    }
  } catch (error) {
    console.error('Error in LDAP test connection endpoint:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Internal server error' 
    });
  }
});

// WhatsApp Connection Function
async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
  // Use latest WhatsApp Web version to avoid handshake issues
  const { version, isLatest } = await fetchLatestBaileysVersion();
  if (!isLatest) {
    console.log('ℹ️ Baileys not using latest WA Web version — setting explicit version to avoid 405/handshake failures');
  }
  
  sock = makeWASocket({
    auth: state,
    version,
    browser: Browsers.macOS('Chrome'),
    // QR is handled via connection.update; avoid deprecated printQRInTerminal option
    logger: P({ level: 'silent' })
  });
  
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    
    if (qr) {
      qrDinamic = qr;
      try {
        const qrCodeDataURL = await QRCode.toDataURL(qr);
        if (soket) {
          soket.emit('qr', qrCodeDataURL);
        }
        console.log('QR Code generated and sent to client');
      } catch (error) {
        console.error('Error generating QR code:', error);
      }
    }
    
    if (connection === 'close') {
      const errorCode = lastDisconnect?.error?.output?.statusCode;
      const errorData = lastDisconnect?.error?.data;
      const errorMessage = lastDisconnect?.error?.message;
      
      console.log('Connection closed due to ', lastDisconnect?.error, ', reconnecting analysis...');
      console.log('Error details:', {
        statusCode: errorCode,
        message: errorMessage,
        data: errorData
      });
      
      // Determine if this is a real logout vs authentication conflict
      let shouldReconnect = false;
      let reconnectDelay = 3000;
      let clearSession = false;
      
      if (errorCode === DisconnectReason.loggedOut) {
        // True user logout - don't reconnect
        console.log('🛑 User logged out - not reconnecting');
        shouldReconnect = false;
      } else if (errorCode === 401) {
         // Authentication conflict - check if it's a session conflict vs real logout
         if (errorData?.reason === '401' && (errorData?.location === 'odn' || errorData?.location === 'cln')) {
           // This is a session conflict, not a real logout (odn = other device new, cln = client)
           console.log(`🔴 Authentication conflict detected (401). Session conflict from multiple devices (${errorData.location}).`);
           shouldReconnect = true;
           clearSession = true;
           reconnectDelay = 5000;
         } else {
           // Other 401 errors might be real logouts
           console.log('🔴 Authentication error (401). Treating as logout.');
           shouldReconnect = false;
         }
      } else if (errorCode === 428) {
        // Connection closed - likely network issue
        console.log('🟡 Connection closed error (428). Network issue detected.');
        shouldReconnect = true;
        reconnectDelay = 5000;
      } else if (errorCode === 405) {
        // Method Not Allowed - often indicates session conflicts or server-side issues
        console.log('🔴 Method Not Allowed error (405). Session conflict or server issue detected.');
        shouldReconnect = true;
        // Treat 405 as transient; do not clear session aggressively
        clearSession = false;
        reconnectDelay = 15000; // Longer delay for 405 errors
      } else if (errorMessage?.includes('conflict') || errorMessage?.includes('Connection Failure')) {
        // Stream conflict - multiple sessions
        console.log('🔴 Stream conflict detected. Multiple sessions may be active.');
        shouldReconnect = true;
        clearSession = true;
        reconnectDelay = 10000;
      } else {
        // Default case - try to reconnect unless it's a known logout reason
        shouldReconnect = true;
        console.log('🟡 Unknown error - attempting reconnection');
      }
      
      if (soket) {
        if (shouldReconnect) {
          soket.emit('message', 'Connection lost. Reconnecting...');
        } else {
          soket.emit('message', 'WhatsApp logged out. Please scan QR code again.');
        }
      }
      
      if (shouldReconnect) {
        if (clearSession) {
          // Clean up auth files without removing the mount point (Docker-safe)
          console.log('🔄 Session conflict detected - attempting in-place auth cleanup...');
          const fs = require('fs');
          const path = require('path');
          const authPath = '/app/auth_info_baileys';
          try {
            if (sock) {
              try {
                sock.end();
                console.log('🔌 Current socket connection terminated');
              } catch (sockError) {
                console.log('⚠️ Socket termination error:', sockError.message);
              }
            }
            if (fs.existsSync(authPath)) {
              const entries = fs.readdirSync(authPath);
              let removed = 0;
              for (const entry of entries) {
                const full = path.join(authPath, entry);
                try {
                  fs.rmSync(full, { recursive: true, force: true });
                  removed++;
                } catch (rmErr) {
                  console.log(`⚠️ Failed to remove ${full}:`, rmErr.message);
                }
              }
              console.log(`✅ Cleared ${removed} auth file(s) from ${authPath}.`);
            } else {
              console.log('ℹ️ Auth path does not exist, skipping cleanup');
            }
          } catch (cleanupErr) {
            console.error('❌ In-place auth cleanup failed:', cleanupErr.message);
            // As a last resort in Docker, create restart signal for external monitor
            try {
              fs.writeFileSync('/tmp/whatsapp_restart_required', new Date().toISOString());
              console.log('✅ Restart signal created. Container should be restarted externally.');
              setTimeout(() => process.exit(1), 2000);
            } catch (signalError) {
              console.error('❌ Failed to create restart signal:', signalError.message);
            }
          }
        }
        
        console.log(`⏳ Reconnecting in ${reconnectDelay/1000} seconds...`);
        setTimeout(() => {
          connectToWhatsApp();
        }, reconnectDelay);
      }
    } else if (connection === 'open') {
      console.log('WhatsApp connection opened');
      
      // Get our own number and LID
      const rawUserId = sock.user?.id;
      who_i_am = lidToPhoneNumber(rawUserId);
      who_i_am_lid = rawUserId?.split('@')[0] || null;
      
      console.log('Connected as:', who_i_am, '(Raw ID:', rawUserId, ', LID:', who_i_am_lid, ')');
      
      // Test bot self-recognition immediately after connection
      console.log('\n=== TESTING BOT SELF-RECOGNITION ===');
      const testMentions = [
        '6281145401505@s.whatsapp.net',
        '6281145401505',
        who_i_am,
        who_i_am_lid
      ];
      
      testMentions.forEach(mention => {
        if (mention) {
          const result = isOurApiNumber(mention);
          console.log(`Test: ${mention} -> ${result ? '✅ RECOGNIZED' : '❌ NOT RECOGNIZED'}`);
        }
      });
      console.log('=== END SELF-RECOGNITION TEST ===\n');
      console.log('=== WHATSAPP USER OBJECT ===');
      console.log('User Object:', JSON.stringify(sock.user, null, 2));
      console.log('=== END USER OBJECT ===');
      
      // Initialize LID Mapping Manager
      try {
        lidMappingManager = new LIDMappingManager();
        await lidMappingManager.initialize(sock);
        
        // Clean up false pushName mappings
    lidMappingManager.cleanupFalseMappings();
    
    // Link LID contacts with phone number contacts
    lidMappingManager.linkLidToPhoneContacts();
    
    await lidMappingManager.saveContactsToFile();
        
        // Store our own mapping with configurable pushName
        if (who_i_am_lid && who_i_am) {
          // Use environment variable for bot name, fallback to 'AI Assistant'
          const ourPushName = process.env.BOT_DISPLAY_NAME || 'AI Assistant';
          
          console.log('🤖 Setting AI bot pushName to:', ourPushName);
          
          lidMappingManager.storeContactInfo({
            id: rawUserId,
            phoneNumber: who_i_am,
            lid: who_i_am_lid,
            pushName: ourPushName,
            source: 'self',
            lastSeen: new Date().toISOString()
          });
          console.log('✅ Stored our own LID mapping:', who_i_am_lid, '->', who_i_am, 'with pushName:', ourPushName);
        }
        
        // Start comprehensive chat scan
        console.log('🚀 Starting comprehensive chat scan for LID mapping...');
        setTimeout(async () => {
          try {
            await lidMappingManager.scanAllChats();
            console.log('✅ Initial chat scan completed');
          } catch (error) {
            console.error('❌ Error during initial chat scan:', error);
          }
        }, 5000); // Wait 5 seconds after connection to start scan
        
      } catch (error) {
        console.error('Failed to initialize LID Mapping Manager:', error);
      }
      
      if (soket) {
        soket.emit('ready', 'WhatsApp is ready!');
        soket.emit('message', 'WhatsApp connection established successfully');
      }
      
      // Send connection notification to admin
      try {
        const adminJid = `${ADMIN_NUMBER}@s.whatsapp.net`;
        await sock.sendMessage(adminJid, { 
          text: `🟢 WhatsApp API Connected Successfully!\n\nAPI Number: ${who_i_am}\nTimestamp: ${new Date().toLocaleString()}\nStatus: Ready to receive commands` 
        });
        console.log('Connection notification sent to admin:', ADMIN_NUMBER);
      } catch (error) {
        console.error('Failed to send connection notification:', error);
      }
    }
  });
  
  sock.ev.on('creds.update', saveCreds);
  
  // Listen for contact updates to maintain LID mapping
  sock.ev.on('contacts.update', (contacts) => {
    console.log('Contacts updated, refreshing LID mapping...');
    updateLidMapping(contacts);
  });
  
  sock.ev.on('contacts.upsert', (contacts) => {
    console.log('New contacts added, updating LID mapping...');
    updateLidMapping(contacts);
  });
  
  // Listen for presence updates (typing status)
  sock.ev.on('presence.update', (presenceUpdate) => {
    if (!PRESENCE_BUFFER_ENABLED) {
      return;
    }
    
    try {
      const { id, presences } = presenceUpdate;
      
      // Extract phone number from JID
      const phoneNumber = lidToPhoneNumber(id);
      if (!phoneNumber) {
        return;
      }
      
      // Get the latest presence status
      const presenceEntries = Object.entries(presences || {});
      if (presenceEntries.length === 0) {
        return;
      }
      
      // Get the most recent presence update
      const [participantId, presenceData] = presenceEntries[0];
      const presence = presenceData?.lastKnownPresence;
      
      if (presence) {
        handlePresenceUpdate(phoneNumber, presence);
      }
    } catch (error) {
      console.error('❌ Error processing presence update:', error.message);
    }
  });
  
  sock.ev.on('messages.upsert', async (m) => {
    const message = m.messages[0];
    if (!message.key.fromMe && m.type === 'notify') {
      // Ignore status broadcast messages
      if (message.key.remoteJid === 'status@broadcast') {
        console.log('Ignoring status broadcast message');
        return;
      }
      // Enhanced media message handling with multiple attachment support
      let messageText;
      let mediaInfo = null;
      let attachments = []; // Array to store multiple attachments
      
      if (message.message?.conversation) {
        messageText = message.message.conversation;
      } else if (message.message?.extendedTextMessage?.text) {
        messageText = message.message.extendedTextMessage.text;
      } else if (message.message?.ephemeralMessage?.message?.conversation) {
        messageText = message.message.ephemeralMessage.message.conversation;
      } else if (message.message?.ephemeralMessage?.message?.extendedTextMessage?.text) {
        messageText = message.message.ephemeralMessage.message.extendedTextMessage.text;
      } else if (message.message?.imageMessage) {
        const attachment = await processMediaAttachment(message, 'image', message.message.imageMessage);
        attachments.push(attachment);
        mediaInfo = attachment; // Keep backward compatibility
        messageText = attachment.caption || 'Image message received';
      } else if (message.message?.ephemeralMessage?.message?.imageMessage) {
        const attachment = await processMediaAttachment(message, 'image', message.message.ephemeralMessage.message.imageMessage);
        attachments.push(attachment);
        mediaInfo = attachment; // Keep backward compatibility
        messageText = attachment.caption || 'Image message received';
      } else if (message.message?.videoMessage) {
        const attachment = await processMediaAttachment(message, 'video', message.message.videoMessage);
        attachments.push(attachment);
        mediaInfo = attachment; // Keep backward compatibility
        messageText = attachment.caption || 'Video message received';
      } else if (message.message?.ephemeralMessage?.message?.videoMessage) {
        const attachment = await processMediaAttachment(message, 'video', message.message.ephemeralMessage.message.videoMessage);
        attachments.push(attachment);
        mediaInfo = attachment; // Keep backward compatibility
        messageText = attachment.caption || 'Video message received';
      } else if (message.message?.audioMessage) {
        const attachment = await processMediaAttachment(message, 'audio', message.message.audioMessage);
        attachments.push(attachment);
        mediaInfo = attachment; // Keep backward compatibility
        messageText = attachment.ptt ? 'Voice message received' : 'Audio message received';
      } else if (message.message?.ephemeralMessage?.message?.audioMessage) {
        const attachment = await processMediaAttachment(message, 'audio', message.message.ephemeralMessage.message.audioMessage);
        attachments.push(attachment);
        mediaInfo = attachment; // Keep backward compatibility
        messageText = attachment.ptt ? 'Voice message received' : 'Audio message received';
      } else if (message.message?.documentMessage) {
        const attachment = await processMediaAttachment(message, 'document', message.message.documentMessage);
        attachments.push(attachment);
        mediaInfo = attachment; // Keep backward compatibility
        messageText = attachment.caption || `Document: ${attachment.fileName}`;
      } else if (message.message?.ephemeralMessage?.message?.documentMessage) {
        const attachment = await processMediaAttachment(message, 'document', message.message.ephemeralMessage.message.documentMessage);
        attachments.push(attachment);
        mediaInfo = attachment; // Keep backward compatibility
        messageText = attachment.caption || `Document: ${attachment.fileName}`;
      } else {
        messageText = 'Media message received';
      }
      
      // Determine sender information correctly for both direct and group messages
      const isGroup = message.key.remoteJid.endsWith('@g.us');
      let sender, actualSender;
      
      if (isGroup) {
        // For group messages, use participantPn (phone number) first, fallback to participant (LID)
        actualSender = message.key.participantPn || message.key.participant;
        sender = message.key.remoteJid; // Keep group ID for context
      } else {
        // For direct messages, remoteJid is the actual sender
        actualSender = message.key.remoteJid;
        sender = message.key.remoteJid;
      }
      
      const formattedMessage = `**From:** ${isGroup ? `${actualSender} (in ${sender})` : sender}\n**Message:** ${messageText}`;

        console.log('New message:', formattedMessage);
        // Raw message object logged for debugging
      
      if (soket) {
        soket.emit('message', formattedMessage);
      }
      // Log the raw message object
      console.log('Raw Message:', JSON.stringify(message, null, 2));
      // Determine if we should reply to this message
      const senderNumber = lidToPhoneNumber(actualSender); // Use actual sender for phone number lookup
      let shouldReply = false;
      
      console.log('Processing message from:', senderNumber, '(Raw sender:', sender, ')');
      
      // Check if we should reply to direct messages from any user
      if (!isGroup) {
        // Check if message starts with / (chatbot command) - ignore these
        if (messageText && /^\//.test(messageText.trim())) {
          console.log('Ignoring chatbot command:', messageText.trim());
          return; // Skip processing this message
        }
        
        console.log('Direct message detected, will reply');
        shouldReply = true;
      }
      
      // Check if we should reply to group messages (when tagged) - treat like direct messages
      if (isGroup && who_i_am) {
        // Extract base phone number (without device suffix like :66)
        const ourBasePhone = who_i_am.split(':')[0];
        const ourLidBase = who_i_am_lid ? who_i_am_lid.split(':')[0] : null;
        
        // Check for mentions in the message text
        const textMentions = [
          messageText.includes(`@${who_i_am}`),        // Full format with device suffix
          messageText.includes(`@${ourBasePhone}`),    // Base phone number (most common)
          who_i_am_lid && messageText.includes(`@${who_i_am_lid}`),
          ourLidBase && messageText.includes(`@${ourLidBase}`)
        ];
        
        // Check for mentions in contextInfo (including ephemeral messages)
        const mentionedJids = message.message?.extendedTextMessage?.contextInfo?.mentionedJid || 
                             message.message?.ephemeralMessage?.message?.extendedTextMessage?.contextInfo?.mentionedJid || 
                             [];
        
        console.log('Checking mentions:- ', {
          messageText,
          mentionedJids,
          who_i_am,
          who_i_am_lid,
          ourBasePhone,
          ourLidBase,
          textMentions
        });
        
        // Check if any mentioned JID belongs to our API number
        const jidMentions = mentionedJids.some(jid => {
          const isOurNumber = isOurApiNumber(jid);
          console.log(`Checking JID: ${jid} -> isOurNumber: ${isOurNumber}`);
          return isOurNumber;
        });
        
        // If tagged in group, treat like direct message (reply regardless of sender)
        const isTagged = textMentions.some(Boolean) || jidMentions;
        if (isTagged) {
          // Check if message starts with "/" (chatbot command) - ignore these
          if (messageText.startsWith('/')) {
            console.log('Ignoring group chatbot command:', messageText);
            return;
          }
          shouldReply = true;
        }
        
        // Tag detection completed
      }
      
      // Prepare message data for buffering or direct processing
      // Extract and format quoted message information
      let quotedMessageInfo = null;
      
      // Debug: Log the complete message structure to understand quote detection
      console.log('🔍 Complete message structure:');
      console.log('- Raw message keys:', Object.keys(message.message || {}));
      console.log('- Message content:', JSON.stringify(message.message, null, 2));
      
      const contextInfo = message.message?.extendedTextMessage?.contextInfo || 
                         message.message?.imageMessage?.contextInfo || 
                         message.message?.videoMessage?.contextInfo || 
                         message.message?.audioMessage?.contextInfo || 
                         message.message?.documentMessage?.contextInfo ||
                         message.message?.ephemeralMessage?.message?.extendedTextMessage?.contextInfo ||
                         message.message?.ephemeralMessage?.message?.imageMessage?.contextInfo ||
                         message.message?.ephemeralMessage?.message?.videoMessage?.contextInfo ||
                         message.message?.ephemeralMessage?.message?.audioMessage?.contextInfo ||
                         message.message?.ephemeralMessage?.message?.documentMessage?.contextInfo;
      
      console.log('- contextInfo found:', !!contextInfo);
      console.log('- quotedMessage in contextInfo:', !!contextInfo?.quotedMessage);
      if (contextInfo) {
        console.log('- contextInfo keys:', Object.keys(contextInfo));
      }
      
      if (contextInfo?.quotedMessage) {
        const quoted = contextInfo.quotedMessage;
        let quotedText = '';
        let quotedType = 'unknown';
        let quotedMediaInfo = null;
        
        // Extract text and download media from different quoted message types
        // Handle both direct and ephemeral quoted messages
        const actualQuoted = quoted.ephemeralMessage?.message || quoted;
        
        if (quoted.conversation) {
          quotedText = quoted.conversation;
          quotedType = 'text';
        } else if (quoted.extendedTextMessage?.text) {
          quotedText = quoted.extendedTextMessage.text;
          quotedType = 'extended_text';
        } else if (actualQuoted.imageMessage) {
          quotedText = actualQuoted.imageMessage.caption || 'Image';
          quotedType = 'image';
          
          // Download quoted image
          try {
            const quotedImageBuffer = await downloadMediaMessage({ message: { imageMessage: actualQuoted.imageMessage } }, 'buffer');
            quotedMediaInfo = {
              type: 'image',
              caption: actualQuoted.imageMessage.caption || '',
              mimetype: actualQuoted.imageMessage.mimetype || 'image/jpeg',
              fileLength: actualQuoted.imageMessage.fileLength || 0,
              width: actualQuoted.imageMessage.width || null,
              height: actualQuoted.imageMessage.height || null,
              imageData: quotedImageBuffer ? quotedImageBuffer.toString('base64') : null
            };
            console.log(`Downloaded quoted image: ${quotedImageBuffer ? quotedImageBuffer.length : 0} bytes`);
          } catch (error) {
            console.error('Failed to download quoted image:', error.message);
            quotedMediaInfo = {
              type: 'image',
              caption: actualQuoted.imageMessage.caption || '',
              mimetype: actualQuoted.imageMessage.mimetype || 'image/jpeg',
              fileLength: actualQuoted.imageMessage.fileLength || 0,
              width: actualQuoted.imageMessage.width || null,
              height: actualQuoted.imageMessage.height || null,
              imageData: null
            };
          }
        } else if (actualQuoted.videoMessage) {
          quotedText = actualQuoted.videoMessage.caption || 'Video';
          quotedType = 'video';
          
          // Download quoted video
          try {
            const quotedVideoBuffer = await downloadMediaMessage({ message: { videoMessage: actualQuoted.videoMessage } }, 'buffer');
            quotedMediaInfo = {
              type: 'video',
              caption: actualQuoted.videoMessage.caption || '',
              mimetype: actualQuoted.videoMessage.mimetype || 'video/mp4',
              fileLength: actualQuoted.videoMessage.fileLength || 0,
              seconds: actualQuoted.videoMessage.seconds || null,
              width: actualQuoted.videoMessage.width || null,
              height: actualQuoted.videoMessage.height || null,
              videoData: quotedVideoBuffer ? quotedVideoBuffer.toString('base64') : null
            };
            console.log(`Downloaded quoted video: ${quotedVideoBuffer ? quotedVideoBuffer.length : 0} bytes`);
          } catch (error) {
            console.error('Failed to download quoted video:', error.message);
            quotedMediaInfo = {
              type: 'video',
              caption: actualQuoted.videoMessage.caption || '',
              mimetype: actualQuoted.videoMessage.mimetype || 'video/mp4',
              fileLength: actualQuoted.videoMessage.fileLength || 0,
              seconds: actualQuoted.videoMessage.seconds || null,
              width: actualQuoted.videoMessage.width || null,
              height: actualQuoted.videoMessage.height || null,
              videoData: null
            };
          }
        } else if (actualQuoted.audioMessage) {
          quotedText = actualQuoted.audioMessage.ptt ? 'Voice message' : 'Audio';
          quotedType = 'audio';
          
          // Download quoted audio
          try {
            const quotedAudioBuffer = await downloadMediaMessage({ message: { audioMessage: actualQuoted.audioMessage } }, 'buffer');
            quotedMediaInfo = {
              type: 'audio',
              mimetype: actualQuoted.audioMessage.mimetype || 'audio/ogg',
              fileLength: actualQuoted.audioMessage.fileLength || 0,
              seconds: actualQuoted.audioMessage.seconds || null,
              ptt: actualQuoted.audioMessage.ptt || false,
              audioData: quotedAudioBuffer ? quotedAudioBuffer.toString('base64') : null
            };
            console.log(`Downloaded quoted audio: ${quotedAudioBuffer ? quotedAudioBuffer.length : 0} bytes`);
          } catch (error) {
            console.error('Failed to download quoted audio:', error.message);
            quotedMediaInfo = {
              type: 'audio',
              mimetype: actualQuoted.audioMessage.mimetype || 'audio/ogg',
              fileLength: actualQuoted.audioMessage.fileLength || 0,
              seconds: actualQuoted.audioMessage.seconds || null,
              ptt: actualQuoted.audioMessage.ptt || false,
              audioData: null
            };
          }
        } else if (actualQuoted.documentMessage) {
          quotedText = actualQuoted.documentMessage.caption || actualQuoted.documentMessage.fileName || 'Document';
          quotedType = 'document';
          
          quotedMediaInfo = {
            type: 'document',
            fileName: actualQuoted.documentMessage.fileName || 'Unknown',
            caption: actualQuoted.documentMessage.caption || '',
            mimetype: actualQuoted.documentMessage.mimetype || 'application/octet-stream',
            fileLength: actualQuoted.documentMessage.fileLength || 0
          };
        }
        
        quotedMessageInfo = {
          type: quotedType,
          text: quotedText,
          participant: contextInfo.participant || 'Unknown',
          messageId: contextInfo.stanzaId || null,
          mediaInfo: quotedMediaInfo,
          raw: quoted // Keep raw data for advanced processing
        };
      }

      // Create universal media object for consistent handling
      let universalMedia = null;
      let hasAttachment = false;
      let attachmentType = 'none';
      
      // Check for direct media first
      if (mediaInfo) {
        universalMedia = {
          ...mediaInfo,
          isQuoted: false,
          source: 'direct'
        };
        hasAttachment = true;
        attachmentType = mediaInfo.type;
      }
      // Check for quoted media if no direct media
      else if (quotedMessageInfo && quotedMessageInfo.mediaInfo) {
        universalMedia = {
          ...quotedMessageInfo.mediaInfo,
          isQuoted: true,
          source: 'quoted',
          quotedFrom: quotedMessageInfo.participant,
          quotedMessageId: quotedMessageInfo.messageId
        };
        hasAttachment = true;
        attachmentType = quotedMessageInfo.mediaInfo.type;
      }
      
      // Determine primary message type
      let primaryMessageType = 'text';
      if (message.message?.conversation) {
        primaryMessageType = 'text';
      } else if (message.message?.extendedTextMessage) {
        primaryMessageType = 'extended_text';
      } else if (mediaInfo) {
        primaryMessageType = mediaInfo.type;
      } else {
        primaryMessageType = 'unknown';
      }

      // Get correct pushName from LID mapping manager
      let correctPushName = message.pushName || 'Unknown';
      console.log('🔍 PUSHNAME DEBUG:');
      console.log('  - Original message.pushName:', message.pushName);
      console.log('  - actualSender:', actualSender);
      console.log('  - isGroup:', isGroup);
      console.log('  - message.key.participant:', message.key.participant);
      console.log('  - message.key.participantPn:', message.key.participantPn);
      console.log('  - message.key.remoteJid:', message.key.remoteJid);
      
      // COMMENTED OUT: LID mapping pushName lookup (root cause of bot name issue)
      // if (lidMappingManager && lidMappingManager.isInitialized) {
      //   correctPushName = lidMappingManager.getCorrectPushName(actualSender, message.pushName);
      //   console.log('  - LID Manager returned pushName:', correctPushName);
      // }
      console.log('  - Final correctPushName:', correctPushName);
      console.log('🔍 END PUSHNAME DEBUG\n');

      const messageData = {
        timestamp: new Date().toISOString(),
        messageId: message.key.id,
        from: actualSender, // Use actual sender (participant in groups)
        fromNumber: senderNumber, // Phone number of actual sender
        groupId: isGroup ? sender : null, // Add group ID for context
        replyTo: isGroup ? sender : actualSender, // Reply destination: group for group messages, individual for direct messages
        message: messageText,
        messageType: primaryMessageType,
        hasAttachment: hasAttachment,
        attachmentType: attachmentType,
        media: universalMedia,
        mediaInfo: mediaInfo, // Legacy single media support
        attachments: attachments, // New multiple attachments support
        attachmentCount: attachments.length,
        isGroup: isGroup,
        pushName: correctPushName,
        quotedMessage: quotedMessageInfo,
        mentionedJids: message.message?.extendedTextMessage?.contextInfo?.mentionedJid || [],
        botNumber: who_i_am,
        botLid: who_i_am_lid,
        shouldReply: shouldReply
      };

      // Process contact information with LID mapping manager
      if (lidMappingManager && lidMappingManager.isInitialized) {
        try {
          await lidMappingManager.processMessage(message);
          console.log(`📝 Contact processed: ${senderNumber} (${message.pushName || 'No name'})`);
        } catch (error) {
          console.error('Error processing contact with LID mapping:', error.message);
        }
      }

      // If we should reply, try to buffer the message first
      if (shouldReply) {
        try {
          // Try to add to message buffer
          const wasBuffered = addToMessageBuffer(senderNumber, messageData);
          
          if (!wasBuffered) {
            // Buffering is disabled, process immediately
            await processMessageForReply(messageData);
          }
          // If buffered, the flushMessageBuffer function will handle processing
        } catch (error) {
          console.error('Error in message buffering/processing:', error.message);
          // Fallback to default reply
          await sendDefaultReply(sender, isGroup);
        }
      } else {
        // Check if message is a command before logging
        if (messageText && /^\//.test(messageText.trim())) {
          console.log('Skipping n8n logging for chatbot command:', messageText.trim());
          return; // Skip logging for commands
        }
        
        // For non-reply messages, try buffering for logging
        const wasBuffered = addToMessageBuffer(senderNumber, messageData);
        
        if (!wasBuffered) {
          // Buffering disabled, send directly for logging
          await processMessageForLogging(messageData);
        }
      }
      

      

    }
  });
}

// Socket.IO Connection
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  soket = socket;
  
  socket.emit('message', 'Connected to WhatsApp API server');
  
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

// Start server
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log('Starting WhatsApp connection...');
  connectToWhatsApp();
});

// Graceful shutdown with timeout
process.on('SIGINT', () => {
  console.log('Shutting down gracefully...');
  
  // Force exit after 5 seconds if graceful shutdown fails
  const forceExitTimer = setTimeout(() => {
    console.log('Force exiting after timeout...');
    process.exit(1);
  }, 5000);
  
  if (sock) {
    sock.end();
  }
  
  server.close(() => {
    console.log('Server closed');
    clearTimeout(forceExitTimer);
    process.exit(0);
  });
});