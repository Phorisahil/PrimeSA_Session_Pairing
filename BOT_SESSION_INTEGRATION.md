# PrimeSA_Bot Session Integration

This document describes the private server-to-server flow between PrimeSA Session Pairing and PrimeSA_Bot.

## Required bot environment

```env
SESSION_API_URL=https://primesa-session-pairing.onrender.com
SESSION_API_KEY=YOUR_SECRET
SESSION_ID=session_xxxxxxxxx
BOT_SESSION_DIR=./sessions
```

Use the exact `SESSION_ID` from the WhatsApp confirmation message. A Session ID is only an identifier; it is not `creds.json` and cannot authenticate Baileys by itself.

## Configure the shared secret

Set the same long random value as `SESSION_API_KEY` in the Render service and the bot. Never put it in browser code, a URL, a WhatsApp message, or Git.

## Flow

1. The website creates a QR or pairing session.
2. Baileys writes the complete `auth_info_baileys` directory on the session server.
3. After authentication, the user receives the generated Session ID.
4. The bot calls the private status endpoint with a bearer token.
5. The bot claims the connected session once.
6. The bot downloads the complete auth-state ZIP with the short-lived transfer token.
7. The bot extracts it into a new directory such as `BOT_SESSION_DIR/<sessionId>/`.
8. The bot starts Baileys with `useMultiFileAuthState()` from that directory.

## Check status

```bash
curl -H "Authorization: Bearer YOUR_SECRET" \
  "https://primesa-session-pairing.onrender.com/api/internal/session/session_xxxxxxxxx/status"
```

Successful response contains only metadata:

```json
{
  "success": true,
  "sessionId": "session_xxxxxxxxx",
  "status": "CONNECTED",
  "authenticated": true,
  "claimed": false
}
```

No credentials are returned by this endpoint.

## Claim once

```bash
curl -X POST \
  -H "Authorization: Bearer YOUR_SECRET" \
  -H "X-Bot-Id: PrimeSA_Bot" \
  "https://primesa-session-pairing.onrender.com/api/internal/session/session_xxxxxxxxx/claim"
```

The response contains a short-lived, one-time `transferToken`. A second claim returns `409 Session already claimed`.

## Download complete auth state

```bash
curl -X POST \
  -H "Authorization: Bearer YOUR_SECRET" \
  -H "X-Session-Transfer-Token: TRANSFER_TOKEN" \
  -o session-auth.json \
  "https://primesa-session-pairing.onrender.com/api/internal/session/session_xxxxxxxxx/transfer"
```

The transfer token expires after five minutes and can be used once. The JSON response contains the complete contents of the server-side `auth_info_baileys` directory as `{ path, content }` base64 file entries. Treat this response as secret, do not log it, and delete it after extraction.

Example bot-side extraction:

```js
const targetDir = path.join(process.env.BOT_SESSION_DIR, sessionId);
if (fs.existsSync(targetDir)) {
  throw new Error('Refusing to overwrite an existing bot session directory');
}
fs.mkdirSync(targetDir, { recursive: true });
const bundle = JSON.parse(fs.readFileSync('session-auth.json', 'utf8'));
for (const file of bundle.files) {
  const destination = path.resolve(targetDir, file.path);
  if (!destination.startsWith(path.resolve(targetDir) + path.sep)) throw new Error('Invalid auth-state path');
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, Buffer.from(file.content, 'base64'));
}
const { state, saveCreds } = await useMultiFileAuthState(targetDir);
const sock = makeWASocket({ auth: state });
sock.ev.on('creds.update', saveCreds);
```

Use a trusted ZIP extractor that rejects absolute paths and `..` path traversal. Keep the bot session directory private.

## Errors

- `401`: missing or invalid `Authorization: Bearer` key.
- `404`: Session ID does not exist.
- `409`: Session is not connected or already claimed.
- `410`: Session expired, logged out, invalid, or transfer token already used.

The current service does not provide claim release. If a bot crashes after claiming, an administrator must add a controlled release mechanism or wait for the claim policy to be extended. Do not expose a public release endpoint.

## Persistence and Render

Local sessions use `SESSION_DIR` and preserve all Baileys files. Render Free web services do not provide durable persistent disks, so authenticated sessions can disappear after restart/redeploy. Use the configured persistent disk plan or an external private storage layer before relying on production sessions. Never pretend a free ephemeral filesystem is durable.

The Render environment must contain:

```env
SESSION_API_KEY=YOUR_SECRET
SESSION_DIR=/var/data/sessions
PAIRING_CODE_TTL=90000
PAIRING_STATUS_INTERVAL=2000
```

The bot environment must contain:

```env
SESSION_API_URL=https://primesa-session-pairing.onrender.com
SESSION_API_KEY=YOUR_SECRET
SESSION_ID=session_xxxxxxxxx
BOT_SESSION_DIR=./sessions
```

Neither the frontend nor public session routes access these internal endpoints.
