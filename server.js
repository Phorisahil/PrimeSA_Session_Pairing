const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
require('dotenv').config();
const pino = require('pino');
const SessionManager = require('./utils/sessionManager');

const logger = pino({
  level: process.env.LOG_LEVEL || 'info'
});

const app = express();
const PORT = process.env.PORT || 3000;
const SESSION_DIR = process.env.SESSION_DIR || './sessions';
const PAIRING_CODE_TTL = Number.parseInt(process.env.PAIRING_CODE_TTL, 10) || 90000;
const PAIRING_STATUS_INTERVAL = Number.parseInt(process.env.PAIRING_STATUS_INTERVAL, 10) || 2000;

// Initialize SessionManager
const sessionManager = new SessionManager(SESSION_DIR, { pairingCodeTtl: PAIRING_CODE_TTL });

// Middleware
app.use(cors());
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ limit: '10kb', extended: false }));

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Rate limiting helper
const rateLimiter = {};

function checkRateLimit(ip, limit = 10, windowMs = 60000) {
  const now = Date.now();

  if (!rateLimiter[ip]) {
    rateLimiter[ip] = [];
  }

  rateLimiter[ip] = rateLimiter[ip].filter((time) => now - time < windowMs);

  if (rateLimiter[ip].length >= limit) {
    return false;
  }

  rateLimiter[ip].push(now);
  return true;
}

// Input validation
function validatePhoneInput(phone) {
  if (!phone || typeof phone !== 'string') {
    return null;
  }

  const cleaned = phone.replace(/[^\d+]/g, '');
  const normalized = cleaned.startsWith('0') ? `27${cleaned.slice(1)}` : cleaned;

  if (!/^(\+)?[0-9]{10,15}$/.test(normalized)) {
    return null;
  }

  return normalized.replace(/^\+/, '');
}

function validateSessionId(sessionId) {
  if (!sessionId || typeof sessionId !== 'string') {
    return false;
  }

  return /^session_[0-9]+_[a-z0-9]{9}$/.test(sessionId);
}

// Error handler middleware
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

// Routes

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    status: 'ok',
    timestamp: new Date()
  });
});

// Create pairing session
app.post(
  '/api/session/pair',
  asyncHandler(async (req, res) => {
    const ip = req.ip;

    if (!checkRateLimit(ip, 5, 60000)) {
      return res.status(429).json({
        success: false,
        error: 'Too many requests. Please try again later.'
      });
    }

    const { phone } = req.body;

    const validatedPhone = validatePhoneInput(phone);
    if (!validatedPhone) {
      return res.status(400).json({
        success: false,
        error: 'Invalid phone number. Please provide a valid phone number (e.g., 27821234567).'
      });
    }

    try {
      const sessionId = await sessionManager.createPairingSession(validatedPhone);
      const session = sessionManager.getSession(sessionId);

      if (session && session.pairingCode) {
        logger.info(
          { sessionId, phone: validatedPhone },
          'Pairing session created successfully'
        );

        return res.json({
          success: true,
          sessionId: sessionId,
          pairingCode: session.pairingCode,
          status: session.status,
          createdAt: session.createdAt,
          expiresAt: session.expiresAt,
          expiresIn: Math.max(0, session.expiresAt - Date.now())
        });
      } else {
        return res.status(500).json({
          success: false,
          error: session?.error || 'Failed to generate pairing code. Please try again.'
        });
      }
    } catch (error) {
      logger.error({ error, phone: validatedPhone }, 'Error creating pairing session');

      res.status(500).json({
        success: false,
        error: 'An error occurred while creating the session. Please try again.'
      });
    }
  })
);

// Create QR session
app.post(
  '/api/session/qr',
  asyncHandler(async (req, res) => {
    const ip = req.ip;

    if (!checkRateLimit(ip, 5, 60000)) {
      return res.status(429).json({
        success: false,
        error: 'Too many requests. Please try again later.'
      });
    }

    try {
      const sessionId = await sessionManager.createQRSession();
      const session = sessionManager.getSession(sessionId);

      logger.info({ sessionId }, 'QR session created');

      res.json({
        success: true,
        sessionId: sessionId,
        status: session.status
      });
    } catch (error) {
      logger.error({ error }, 'Error creating QR session');

      res.status(500).json({
        success: false,
        error: 'An error occurred while creating the QR session. Please try again.'
      });
    }
  })
);

// Get session status
app.get(
  '/api/session/status/:sessionId',
  asyncHandler(async (req, res) => {
    const { sessionId } = req.params;

    if (!validateSessionId(sessionId)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid session ID.'
      });
    }

    const session = await sessionManager.getOrLoadSession(sessionId);
    const status = sessionManager.getSessionStatus(sessionId);

    if (!session && !status) {
      return res.status(404).json({
        success: false,
        error: 'Session not found.'
      });
    }

    res.json({
      success: true,
      sessionId,
      status: status.status,
      method: status.method,
      createdAt: status.createdAt,
      connectedAt: status.connectedAt,
      expiresAt: status.expiresAt,
      expiresIn: status.expiresIn,
      error: status.error || null,
      pollInterval: PAIRING_STATUS_INTERVAL
    });
  })
);

// Get QR code
app.get(
  '/api/session/qr/:sessionId',
  asyncHandler(async (req, res) => {
    const { sessionId } = req.params;

    if (!validateSessionId(sessionId)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid session ID.'
      });
    }

    const session = await sessionManager.getOrLoadSession(sessionId);

    if (!session) {
      return res.status(404).json({
        success: false,
        error: 'Session not found.'
      });
    }

    const qrCode = sessionManager.getQRCode(sessionId);

    if (!qrCode) {
      return res.status(202).json({
        success: false,
        error: 'QR code not ready yet. Please wait.'
      });
    }

    res.json({
      success: true,
      qr: qrCode.toString('utf-8'),
      sessionId: sessionId
    });
  })
);

// Get pairing code
app.get(
  '/api/session/pairing/:sessionId',
  asyncHandler(async (req, res) => {
    const { sessionId } = req.params;

    if (!validateSessionId(sessionId)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid session ID.'
      });
    }

    const session = await sessionManager.getOrLoadSession(sessionId);

    if (!session) {
      return res.status(404).json({
        success: false,
        error: 'Session not found.'
      });
    }

    const pairingCode = sessionManager.getPairingCode(sessionId);

    if (!pairingCode) {
      return res.status(202).json({
        success: false,
        error: 'Pairing code not ready yet. Please wait.'
      });
    }

    res.json({
      success: true,
      pairingCode: pairingCode,
      sessionId: sessionId
    });
  })
);

// Delete session
app.delete(
  '/api/session/:sessionId',
  asyncHandler(async (req, res) => {
    const { sessionId } = req.params;

    if (!validateSessionId(sessionId)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid session ID.'
      });
    }

    try {
      await sessionManager.deleteSession(sessionId);

      logger.info({ sessionId }, 'Session deleted');

      res.json({
        success: true,
        message: 'Session deleted successfully.'
      });
    } catch (error) {
      logger.error({ error, sessionId }, 'Error deleting session');

      res.status(500).json({
        success: false,
        error: 'An error occurred while deleting the session.'
      });
    }
  })
);

// Get all active sessions (for debugging)
app.get('/api/sessions', (req, res) => {
  const sessions = sessionManager.getAllActiveSessions();

  res.json({
    success: true,
    count: sessions.length,
    sessions: sessions
  });
});

// Serve index.html for all other routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Global error handler
app.use((err, req, res, next) => {
  logger.error({ error: err }, 'Unhandled error');

  res.status(500).json({
    success: false,
    error: 'An internal server error occurred. Please try again later.'
  });
});

// Session cleanup on server start
async function initializeServer() {
  logger.info(`Loading existing sessions from ${SESSION_DIR}...`);
  await sessionManager.loadAllExistingSessions();

  const sessionCount = sessionManager.getSessionCount();
  logger.info(`${sessionCount} existing session(s) loaded.`);
}

// Start server
const server = app.listen(PORT, async () => {
  await initializeServer();
  logger.info(`PrimeSA Session server running on http://localhost:${PORT}`);
  logger.info(`Session directory: ${SESSION_DIR}`);
  logger.info('Press Ctrl+C to stop the server');
});

// Graceful shutdown
process.on('SIGINT', async () => {
  logger.info('Shutting down server...');

  const sessions = sessionManager.getAllActiveSessions();
  for (const session of sessions) {
    try {
      await sessionManager.disconnectSession(session.id);
    } catch (error) {
      logger.error({ error, sessionId: session.id }, 'Error disconnecting session');
    }
  }

  server.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });

  setTimeout(() => {
    logger.error('Forcing shutdown');
    process.exit(1);
  }, 5000);
});

module.exports = app;
