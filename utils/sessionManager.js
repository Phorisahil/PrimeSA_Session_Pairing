const fs = require('fs');
const path = require('path');
const pino = require('pino');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  Browsers,
  delay,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  jidNormalizedUser
} = require('@whiskeysockets/baileys');

const logger = pino();

class SessionManager {
  constructor(sessionsDir, options = {}) {
    this.sessionsDir = sessionsDir;
    this.pairingCodeTtl = options.pairingCodeTtl || 90000;
    this.activeSessions = {};
    this.terminalSessions = {};
    this.initializeSessionsDirectory();
  }

  initializeSessionsDirectory() {
    if (!fs.existsSync(this.sessionsDir)) {
      fs.mkdirSync(this.sessionsDir, { recursive: true });
    }
  }

  generateSessionId() {
    return `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  getSessionPath(sessionId) {
    return path.join(this.sessionsDir, sessionId);
  }

  async createSession(sessionId, method) {
    try {
      const sessionPath = this.getSessionPath(sessionId);

      if (!fs.existsSync(sessionPath)) {
        fs.mkdirSync(sessionPath, { recursive: true });
      }

      this.activeSessions[sessionId] = {
        id: sessionId,
        sessionId,
        method: method,
        status: 'initializing',
        socket: null,
        authState: null,
        qrCode: null,
        pairingCode: null,
        phone: null,
        createdAt: Date.now(),
        expiresAt: null,
        connectedAt: null,
        lastStatusUpdate: Date.now(),
        expirationTimer: null,
        reconnectTimer: null,
        reconnectAttempts: 0,
        error: null,
        notificationSent: false,
        notificationInFlight: false
      };

      return this.activeSessions[sessionId];
    } catch (error) {
      logger.error({ error, sessionId }, 'Error creating session');
      throw error;
    }
  }

  async createPairingSession(phone) {
    try {
      if (!this.validatePhoneNumber(phone)) {
        throw new Error('Invalid phone number format');
      }

      const existingSession = this.findActivePairingSession(phone);
      if (existingSession) {
        logger.info({ sessionId: existingSession.id, phone }, 'Pairing session already exists');
        return existingSession.id;
      }

      const sessionId = this.generateSessionId();
      const session = await this.createSession(sessionId, 'pairing');
      const sessionPath = this.getSessionPath(sessionId);

      const { state, saveCreds } = await useMultiFileAuthState(
        path.join(sessionPath, 'auth_info_baileys')
      );

      session.authState = { state, saveCreds };
      session.phone = phone;
      session.status = 'waiting_pairing';
      session.expiresAt = Date.now() + this.pairingCodeTtl;
      session.reconnectAttempts = 0;
      session.reconnectTimer = null;
      session.expirationTimer = setTimeout(() => {
        this.expirePairingSession(sessionId).catch((error) => {
          logger.error({ error, sessionId }, 'Error expiring pairing session');
        });
      }, this.pairingCodeTtl);
      logger.info({ sessionId, phone, expiresAt: session.expiresAt }, 'Pairing session created');

      let version;
      try {
        ({ version } = await fetchLatestBaileysVersion());
      } catch (error) {
        logger.warn({ error }, 'Could not fetch the latest WhatsApp Web version; using Baileys default');
      }

      const socketOptions = {
        ...(version ? { version } : {}),
        printQRInTerminal: false,
        browser: Browsers.windows('Chrome'),
        logger: pino({ level: 'fatal' }),
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'fatal' }))
        },
        markOnlineOnConnect: false,
        generateHighQualityLinkPreview: false,
        defaultQueryTimeoutMs: 60000,
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 30000,
        retryRequestDelayMs: 250,
        maxRetries: 5,
        shouldIgnoreJid: (jid) => false,
        maxMsgsInMemory: 100
      };

      let socket;
      let resolveConnectionStart;
      let rejectConnectionStart;
      let connectionStarted;

      const connectPairingSocket = () => {
        connectionStarted = new Promise((resolve, reject) => {
          resolveConnectionStart = resolve;
          rejectConnectionStart = reject;
        });
        socket = makeWASocket(socketOptions);
        session.socket = socket;

        socket.ev.on('creds.update', saveCreds);
        socket.ev.on('connection.update', async (update) => {
          const { connection, lastDisconnect, isNewLogin, qr } = update;

          if (connection === 'connecting' || connection === 'open') {
            resolveConnectionStart();
          }

          if (qr) session.qrCode = qr;

          const authenticated = isNewLogin || (connection === 'open' && state.creds.registered);
          if (authenticated) {
            session.status = 'connected';
            session.connectedAt = new Date();
            this.clearPairingExpiration(session);
            logger.info({ sessionId }, 'WhatsApp authentication successful');
            this.notifyAuthenticatedUser(sessionId, socket, state).catch((error) => {
              logger.error({ error, sessionId }, 'Authentication notification failed');
            });
          }

          if (connection === 'close') {
            if (session.status === 'expired' || session.status === 'cancelled') return;
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const errorMessage = lastDisconnect?.error?.message || 'Connection closed';
            logger.warn({ sessionId, statusCode, error: errorMessage }, 'WhatsApp pairing connection closed');
            rejectConnectionStart(new Error(errorMessage));

            const hasPairingCode = Boolean(session.pairingCode);
            const isLoggedOut = statusCode === DisconnectReason.loggedOut && !hasPairingCode;

            if (isLoggedOut) {
              session.status = 'logged_out';
            } else if (this.getSession(sessionId) && session.reconnectAttempts < 5) {
              session.status = hasPairingCode ? 'awaiting_pairing' : 'retrying_pairing';
              session.reconnectAttempts += 1;
              session.reconnectTimer = setTimeout(connectPairingSocket, Math.min(session.reconnectAttempts * 2000, 10000));
              logger.info({ sessionId, attempt: session.reconnectAttempts }, 'Retrying WhatsApp pairing connection');
            } else {
              session.status = 'failed';
              session.error = 'WhatsApp connection closed after several retries.';
            }
          }
        });
      };

      connectPairingSocket();

      // For pairing code method, request the pairing code
      if (phone) {
        try {
          let pairingCode;
          let lastError;

          for (let attempt = 1; attempt <= 3; attempt += 1) {
            try {
              await Promise.race([
                connectionStarted,
                new Promise((resolve) => setTimeout(resolve, 10000))
              ]);
              await delay(3000);
              pairingCode = await socket.requestPairingCode(phone);
              break;
            } catch (error) {
              lastError = error;
              logger.warn({ sessionId, attempt, error: error.message }, 'Pairing code request failed; retrying');
              if (attempt < 3) {
                connectPairingSocket();
                await delay(2000);
              }
            }
          }

          if (!pairingCode) throw lastError || new Error('Pairing code unavailable');
          session.pairingCode = pairingCode.match(/.{1,4}/g)?.join('-') || pairingCode;
          session.status = 'awaiting_pairing';
          session.reconnectAttempts = 0;
          logger.info({ sessionId, phone }, 'Pairing code generated');
        } catch (error) {
          logger.error({ error, sessionId, phone }, 'Error generating pairing code');
          session.status = 'failed';
          session.error = error.message;
        }
      }

      return sessionId;
    } catch (error) {
      logger.error({ error }, 'Error creating pairing session');
      throw error;
    }
  }

  async createQRSession() {
    try {
      const sessionId = this.generateSessionId();
      const session = await this.createSession(sessionId, 'qr');
      const sessionPath = this.getSessionPath(sessionId);

      const { state, saveCreds } = await useMultiFileAuthState(
        path.join(sessionPath, 'auth_info_baileys')
      );

      session.authState = { state, saveCreds };
      session.status = 'waiting_qr';
      session.reconnectAttempts = 0;
      session.reconnectTimer = null;

      let version;
      try {
        ({ version } = await fetchLatestBaileysVersion());
      } catch (error) {
        logger.warn({ error }, 'Could not fetch the latest WhatsApp Web version; using Baileys default');
      }

      const socketOptions = {
        ...(version ? { version } : {}),
        printQRInTerminal: false,
        browser: Browsers.windows('Chrome'),
        logger: pino({ level: 'fatal' }),
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'fatal' }))
        },
        markOnlineOnConnect: false,
        generateHighQualityLinkPreview: false,
        defaultQueryTimeoutMs: 60000,
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 30000,
        retryRequestDelayMs: 250,
        maxRetries: 5,
        shouldIgnoreJid: (jid) => false,
        maxMsgsInMemory: 100
      };

      const connectQRSocket = () => {
        const socket = makeWASocket(socketOptions);
        session.socket = socket;
        socket.ev.on('creds.update', saveCreds);
        socket.ev.on('connection.update', async (update) => {
          const { connection, lastDisconnect, isNewLogin, qr } = update;

          if (qr) {
            session.qrCode = qr;
            session.status = 'qr';
            logger.info({ sessionId }, 'QR code generated');
          }

          if (isNewLogin || connection === 'open') {
            session.status = 'connected';
            session.connectedAt = new Date();
            session.reconnectAttempts = 0;
            logger.info({ sessionId }, 'WhatsApp session connected');

            if (state.creds.registered) {
              this.notifyAuthenticatedUser(sessionId, socket, state).catch((error) => {
                logger.error({ error, sessionId }, 'Authentication notification failed');
              });
            }
          }

          if (connection === 'close') {
            if (session.status === 'expired' || session.status === 'cancelled') return;
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const loggedOut = statusCode === DisconnectReason.loggedOut || statusCode === 401;
            logger.warn({ sessionId, statusCode, error: lastDisconnect?.error?.message }, 'WhatsApp QR connection closed');

            if (loggedOut) {
              session.status = 'logged_out';
              await this.cleanupSession(sessionId);
              return;
            }

            if (this.getSession(sessionId) && session.reconnectAttempts < 5) {
              session.status = 'reconnecting';
              session.reconnectAttempts += 1;
              session.reconnectTimer = setTimeout(connectQRSocket, Math.min(session.reconnectAttempts * 2000, 10000));
              logger.info({ sessionId, attempt: session.reconnectAttempts }, 'Retrying WhatsApp QR connection');
            } else {
              session.status = 'failed';
              session.error = 'WhatsApp connection closed after several retries.';
            }
          }
        });
        socket.ev.on('call', async () => {});
      };

      connectQRSocket();
      return sessionId;
    } catch (error) {
      logger.error({ error }, 'Error creating QR session');
      throw error;
    }
  }

  getSession(sessionId) {
    return this.activeSessions[sessionId];
  }

  findActivePairingSession(phone) {
    return Object.values(this.activeSessions).find((session) => {
      const activeStatuses = ['waiting_pairing', 'retrying_pairing', 'awaiting_pairing', 'connecting'];
      return session.method === 'pairing' && session.phone === phone && activeStatuses.includes(session.status);
    });
  }

  clearPairingExpiration(session) {
    if (session.expirationTimer) {
      clearTimeout(session.expirationTimer);
      session.expirationTimer = null;
    }
    session.expiresAt = null;
  }

  async expirePairingSession(sessionId) {
    const session = this.getSession(sessionId);
    if (!session || session.status === 'connected') return;

    session.status = 'expired';
    session.error = 'Pairing code expired.';
    logger.info({ sessionId }, 'Pairing session expired');

    if (session.socket) {
      try {
        await session.socket.end(new Error('Pairing code expired'));
      } catch (error) {
        logger.debug({ error, sessionId }, 'Error ending expired pairing socket');
      }
    }
    if (session.reconnectTimer) clearTimeout(session.reconnectTimer);
    const sessionPath = this.getSessionPath(sessionId);
    if (fs.existsSync(sessionPath)) {
      fs.rmSync(sessionPath, { recursive: true, force: true });
    }
    this.terminalSessions[sessionId] = {
      id: sessionId,
      sessionId,
      method: session.method,
      phone: session.phone,
      status: session.status,
      pairingCode: session.pairingCode,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
      connectedAt: session.connectedAt,
      error: session.error
    };
    delete this.activeSessions[sessionId];
  }

  getSessionStatus(sessionId) {
    const session = this.getSession(sessionId) || this.terminalSessions[sessionId];
    if (!session) {
      return null;
    }

    return {
      status: session.status,
      method: session.method,
      createdAt: session.createdAt,
      connectedAt: session.connectedAt,
      lastStatusUpdate: session.lastStatusUpdate,
      expiresAt: session.expiresAt,
      expiresIn: session.expiresAt ? Math.max(0, session.expiresAt - Date.now()) : null,
      error: session.error
    };
  }

  getQRCode(sessionId) {
    const session = this.getSession(sessionId);
    if (!session || !session.qrCode) {
      return null;
    }
    return session.qrCode;
  }

  getPairingCode(sessionId) {
    const session = this.getSession(sessionId);
    if (!session || !session.pairingCode) {
      return null;
    }
    return session.pairingCode;
  }

  async disconnectSession(sessionId) {
    try {
      const session = this.getSession(sessionId);
      if (!session) {
        return;
      }

      if (session.socket) {
        session.status = 'cancelled';
        await session.socket.logout();
        session.status = 'disconnected';
        logger.info({ sessionId }, 'Session disconnected');
      }
    } catch (error) {
      logger.error({ error, sessionId }, 'Error disconnecting session');
    }
  }

  async deleteSession(sessionId) {
    try {
      const session = this.getSession(sessionId);
      if (session?.expirationTimer) clearTimeout(session.expirationTimer);
      if (session?.reconnectTimer) {
        clearTimeout(session.reconnectTimer);
        session.reconnectTimer = null;
      }

      await this.disconnectSession(sessionId);

      const sessionPath = this.getSessionPath(sessionId);
      if (fs.existsSync(sessionPath)) {
        fs.rmSync(sessionPath, { recursive: true, force: true });
      }

      delete this.activeSessions[sessionId];
      delete this.terminalSessions[sessionId];
      logger.info({ sessionId }, 'Session deleted');

      return true;
    } catch (error) {
      logger.error({ error, sessionId }, 'Error deleting session');
      throw error;
    }
  }

  async loadExistingSession(sessionId) {
    try {
      const sessionPath = this.getSessionPath(sessionId);
      const authPath = path.join(sessionPath, 'auth_info_baileys');

      if (!fs.existsSync(authPath)) {
        return null;
      }

      const { state, saveCreds } = await useMultiFileAuthState(authPath);

      if (!state.creds.registered) {
        fs.rmSync(sessionPath, { recursive: true, force: true });
        return null;
      }

      const session = await this.createSession(sessionId, 'recovered');
      session.authState = { state, saveCreds };
      session.status = 'reconnecting';
      session.notificationSent = true;

      const socket = makeWASocket({
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'fatal' }))
        },
        printQRInTerminal: false,
        browser: Browsers.windows('Chrome'),
        logger: pino({ level: 'fatal' }),
        markOnlineOnConnect: false,
        generateHighQualityLinkPreview: false,
        defaultQueryTimeoutMs: 60000,
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 30000,
        retryRequestDelayMs: 250,
        maxRetries: 5,
        shouldIgnoreJid: (jid) => false,
        maxMsgsInMemory: 100
      });

      socket.ev.on('creds.update', saveCreds);

      socket.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'open') {
          session.status = 'connected';
          session.connectedAt = new Date();
          logger.info({ sessionId }, 'Recovered session connected');
        }

        if (connection === 'close') {
          const shouldReconnect =
            lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;

          if (!shouldReconnect) {
            session.status = 'logged_out';
            logger.warn({ sessionId }, 'Recovered session logged out');
          } else {
            session.status = 'disconnected';
          }
        }
      });

      session.socket = socket;
      return sessionId;
    } catch (error) {
      logger.error({ error, sessionId }, 'Error loading existing session');
      return null;
    }
  }

  async loadAllExistingSessions() {
    try {
      if (!fs.existsSync(this.sessionsDir)) {
        return;
      }

      const sessionDirs = fs.readdirSync(this.sessionsDir);

      for (const dir of sessionDirs) {
        if (dir === '.gitkeep') continue;

        try {
          await this.loadExistingSession(dir);
          logger.info({ sessionId: dir }, 'Existing session loaded');
        } catch (error) {
          logger.warn({ error, sessionId: dir }, 'Could not load existing session');
        }
      }
    } catch (error) {
      logger.error({ error }, 'Error loading existing sessions');
    }
  }

  async cleanupSession(sessionId) {
    try {
      const session = this.getSession(sessionId);
      if (!session) {
        return;
      }

      if (session.socket) {
        try {
          await session.socket.end();
        } catch (err) {
          logger.debug({ err }, 'Error ending socket');
        }
      }

      if (session.expirationTimer) clearTimeout(session.expirationTimer);
      if (session.reconnectTimer) clearTimeout(session.reconnectTimer);

      delete this.activeSessions[sessionId];
      logger.info({ sessionId }, 'Session cleaned up');
    } catch (error) {
      logger.error({ error, sessionId }, 'Error cleaning up session');
    }
  }

  async notifyAuthenticatedUser(sessionId, socket, state) {
    const session = this.getSession(sessionId);
    if (!session || session.notificationSent || session.notificationInFlight) return;

    const authenticatedJid = socket.user?.id || state.creds.me?.id;
    if (!authenticatedJid || !state.creds.registered) {
      logger.warn({ sessionId }, 'Authenticated JID unavailable; notification deferred');
      return;
    }

    session.notificationInFlight = true;
    const message = [
      '╭━━━〔 PRIME SA BOT 〕━━━╮',
      '┃',
      '┃ ✅ SESSION CREATED',
      '┃',
      '┃ Your WhatsApp session has',
      '┃ been successfully created.',
      '┃',
      '┃ 🆔 Session ID:',
      `┃ ${sessionId}`,
      '┃',
      '┃ 🟢 Status: Connected',
      '┃',
      '┃ 🔐 Authentication data:',
      '┃ Secured on server',
      '┃',
      '┃ © 2026 by Pro Sahil Phakathwayo',
      '┃',
      '╰━━━━━━━━━━━━━━━━━━━━━━╯'
    ].join('\n');

    try {
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          await socket.sendMessage(jidNormalizedUser(authenticatedJid), { text: message });
          session.notificationSent = true;
          logger.info({ sessionId }, 'Authentication success notification sent');
          return;
        } catch (error) {
          logger.warn({ sessionId, attempt, error: error.message }, 'Could not send authentication notification');
          if (attempt < 3) await delay(attempt * 2000);
        }
      }
    } finally {
      session.notificationInFlight = false;
    }
  }

  async getOrLoadSession(sessionId) {
    let session = this.getSession(sessionId);

    if (!session) {
      const sessionPath = this.getSessionPath(sessionId);
      if (fs.existsSync(sessionPath)) {
        await this.loadExistingSession(sessionId);
        session = this.getSession(sessionId);
      }
    }

    return session;
  }

  validatePhoneNumber(phone) {
    // Validate phone number format (must be digits, optionally starting with +)
    const phoneRegex = /^(\+)?[0-9]{10,15}$/;
    return phoneRegex.test(phone.replace(/[-\s]/g, ''));
  }

  formatPhoneNumber(phone) {
    // Remove non-digit characters except +
    const cleaned = phone.replace(/[^\d+]/g, '');
    // Ensure it starts with country code (e.g., 27 for South Africa)
    if (!cleaned.startsWith('+')) {
      return cleaned;
    }
    return cleaned.substring(1); // Remove + for Baileys
  }

  getAllActiveSessions() {
    return Object.values(this.activeSessions).map((session) => ({
      id: session.id,
      status: session.status,
      method: session.method,
      createdAt: session.createdAt,
      connectedAt: session.connectedAt
    }));
  }

  getSessionCount() {
    return Object.keys(this.activeSessions).length;
  }
}

module.exports = SessionManager;
