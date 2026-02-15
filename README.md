# WhatsApp API Gateway (Baileys + Express)

## Overview
- Provides a simple HTTP API to send WhatsApp messages using Baileys.
- Handles inbound WhatsApp messages and routes them to either command handlers or an N8N webhook for AI/automation.
- Includes IP allow-listing, QR login flow, and optional media sending.

## Features
- Send text and images (file upload, URL, base64) to WhatsApp numbers.
- Bulk messaging with randomized delay between sends.
- Inbound message handling: `/command` vs normal message.
- Optional N8N webhook integration for auto-replies.
- IP allow-listing for endpoints.
- Admin command: `/resetpassword` to update user password in Active Directory.
- Ticket claim via reaction in configured groups (remove reaction to unclaim).

## Requirements
- Node.js 18+
- A WhatsApp account to pair via QR code

## Installation
```bash
npm install
```

## Configuration (.env)
Create a `.env` file in the project root with:
```env
# Server
PORT=8192

# Security
# Comma-separated IPv4 or IPv6 addresses allowed to call endpoints
ALLOWED_IPS=127.0.0.1,::1

# N8N integration (optional)
N8N_WEBHOOK_URL=https://your-n8n-host/webhook/your-workflow
N8N_TIMEOUT=5000

# LDAP (required for /resetpassword)
LDAP_URL=ldap://10.60.10.56:389
BIND_DN=CN=ldapbind,OU=Service Accounts,DC=example,DC=com
BIND_PW=yourStrongPassword
BASE_OU=OU=Users,DC=example,DC=com

# Snipe-IT (required for /getasset)
SNIPEIT_URL=https://snipeit.example.com/api/v1
SNIPEIT_TOKEN=yourSnipeItApiToken

# Authorization for admin commands
ALLOWED_PHONE_NUMBERS=6281234567890,6289876543210
```

Notes:
- If using a self-signed certificate on N8N, HTTPS requests are allowed by default (rejectUnauthorized=false) for the webhook call.
- Ensure an `uploads/` directory exists for image uploads.

## Running
```bash
npm run dev   # nodemon
# or
npm start     # node
```

## Docker
Build + run (reads `.env` and persists WhatsApp state under a Docker volume):
```bash
docker compose up --build
```

Notes:
- Exposes port `8192`.
- Persists `auth_info_baileys/`, `baileys_store.json`, `uploads/`, and `data/` under `DATA_DIR=/data` inside the container.

## Qontak Test
Environment:
```env
MEKARI_API_CLIENT_ID=
MEKARI_API_CLIENT_SECRET=
QONTAK_TO_NUMBER=6281234567890
QONTAK_TO_NAME=Customer
QONTAK_MESSAGE_TEMPLATE_ID=
QONTAK_CHANNEL_INTEGRATION_ID=
QONTAK_LANGUAGE_CODE=id
QONTAK_TEMPLATE_PARAMETERS_JSON={"body":[{"key":"1","value_text":"Hello","value":"hello"}]}
```

Run:
```bash
node qontak.js
```

List templates:
```bash
node qontak.js list-templates
```

Checks:
```bash
npm run lint        # npx tsc --noEmit
```

On first run, scan the QR code printed in the terminal to pair your WhatsApp session.

## API Endpoints

### POST /send-message
- Sends a single message to a WhatsApp number.
- Request body supports one of: `message` (text), `image` (multipart file), `imageUrl`, or `imageBuffer` (base64).

Body (JSON or multipart/form-data):
```
{
  "number": "085712612218",
  "message": "Hello from API"
}
```

Examples:

Send text:
```bash
curl -X POST http://localhost:8192/send-message \
  -H "Content-Type: application/json" \
  -d '{"number":"085712612218","message":"Hello"}'
```

Send image file:
```bash
curl -X POST http://localhost:8192/send-message \
  -F number=085712612218 \
  -F image=@/path/to/image.jpg \
  -F message="Optional caption"
```

Send image by URL:
```bash
curl -X POST http://localhost:8192/send-message \
  -H "Content-Type: application/json" \
  -d '{"number":"085712612218","imageUrl":"https://example.com/image.jpg","message":"Optional caption"}'
```

Send image by base64:
```bash
curl -X POST http://localhost:8192/send-message \
  -H "Content-Type: application/json" \
  -d '{"number":"085712612218","imageBuffer":"<base64>","message":"Optional caption"}'
```

### POST /send-bulk-message
- Sends the same text message to multiple numbers with random delay.

Body (JSON):
```
{
  "message": "Promo!",
  "numbers": ["085700000001","085700000002"],
  "minDelay": 1000,
  "maxDelay": 3000
}
```

Example:
```bash
curl -X POST http://localhost:8192/send-bulk-message \
  -H "Content-Type: application/json" \
  -d '{"message":"Promo!","numbers":["085700000001","085700000002"],"minDelay":1000,"maxDelay":3000}'
```

### POST /webhook (ServiceDesk Plus)
- Receives ServiceDesk Plus ticket events and sends WhatsApp notifications.

Body (JSON):
```
{
  "id": "5733",
  "status": "new",
  "receiver": "120363215673098371@g.us",
  "receiver_type": "group",
  "notify_requester_new": "false",
  "notify_requester_update": "false",
  "notify_requester_assign": "true",
  "notify_technician": "true"
}
```

Notes:
- `notify_requester_new` applies only when `status` is `new`.
- If `notify_requester_new` is omitted, it defaults to `true`.

## Inbound Messages
- All inbound messages are parsed and routed:
  - Messages starting with `/` are treated as commands.
  - Other messages are passed to `handleMessage`. If `N8N_WEBHOOK_URL` is set, the payload is sent to N8N and the first textual response is echoed back.

Built-in commands:
- `/hi` – replies "Hello!"
- `/help` – lists available commands
- `/resetpassword <username> <newPassword> [/change]` – username can be `sAMAccountName`, UPN/email, or CN/displayName (if uniquely matched). Resets AD password; optionally forces change at next logon when `/change` flag is present. Access restricted to `ALLOWED_PHONE_NUMBERS` (works in private chats and groups).
- `/getbitlocker <hostname>` – looks up BitLocker recovery keys for a computer in Active Directory (searches by `cn` / `sAMAccountName`). Requires `LDAP_BASE_DN` (or `BASE_DN` / `BASE_OU`) plus LDAP bind settings.
- `/getasset [type]` – summarizes assets from Snipe-IT by category. Requires `SNIPEIT_URL` and `SNIPEIT_TOKEN`.

## Implementation Notes
- Number formatting auto-converts local `0XXXXXXXXX` to `62XXXXXXXXX@s.whatsapp.net`.
- Registered number check uses Baileys `onWhatsApp`.
- LID to phone fallback mapping supported via reverse mapping files under `auth_info_baileys/`.

## Project Scripts
- Defined in [package.json](file:///Users/widjis/Documents/Projects/whatsapp_api_n8nv2/package.json):
  - `dev` – runs `src/index.ts` via `tsx watch`
  - `build` – compiles TypeScript to `dist/`
  - `start` – runs `dist/index.js`
  - `lint` – runs `npx tsc --noEmit`

## Code References
- Entry: [index.ts](file:///Users/widjis/Documents/Projects/whatsapp_api_n8nv2/src/index.ts)
- Middleware: [checkIp.ts](file:///Users/widjis/Documents/Projects/whatsapp_api_n8nv2/src/features/http/middleware/checkIp.ts)
- Endpoints: [messages.ts](file:///Users/widjis/Documents/Projects/whatsapp_api_n8nv2/src/features/http/routes/messages.ts)
- Inbound handling: [startWhatsApp](file:///Users/widjis/Documents/Projects/whatsapp_api_n8nv2/src/features/whatsapp/start.ts)
- LDAP reset: [resetPassword](file:///Users/widjis/Documents/Projects/whatsapp_api_n8nv2/src/features/integrations/ldap.ts)
