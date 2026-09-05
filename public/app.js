// ============================================================================
// PrimeSA Session Generator - Frontend Application
// ============================================================================

class SessionApp {
  constructor() {
    this.currentSessionId = null;
    this.currentMethod = null;
    this.pollingInterval = null;
    this.qrRefreshInterval = null;
    this.countdownInterval = null;
    this.pairingRequestInFlight = false;
    this.pairingTtl = 90000;
    this.init();
  }

  init() {
    this.setupEventListeners();
  }

  setupEventListeners() {
    // Tab switching
    document.querySelectorAll('.mode-button').forEach((button) => {
      button.addEventListener('click', () => this.switchTab(button.dataset.tab));
    });

    // Pairing code form
    document.getElementById('generatePairingBtn').addEventListener('click', () =>
      this.generatePairingSession()
    );
    document.getElementById('cancelPairingBtn').addEventListener('click', () =>
      this.cancelSession()
    );
    document.getElementById('copyPairingBtn').addEventListener('click', () =>
      this.copyToClipboard('pairingCodeValue')
    );
    document.getElementById('newPairingBtn').addEventListener('click', () => {
      this.resetToHome();
      document.getElementById('phone').focus();
    });

    // QR code form
    document.getElementById('generateQRBtn').addEventListener('click', () =>
      this.generateQRSession()
    );
    document.getElementById('cancelQRBtn').addEventListener('click', () =>
      this.cancelSession()
    );
    document.getElementById('refreshQRBtn').addEventListener('click', () =>
      this.refreshQRCode()
    );

    // Success screen
    document.getElementById('createAnotherBtn').addEventListener('click', () =>
      this.resetToHome()
    );

    // Phone input enter key
    document.getElementById('phone').addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        this.generatePairingSession();
      }
    });
  }

  switchTab(tabName) {
    // Hide all tab contents
    document.querySelectorAll('.mode-panel').forEach((content) => {
      content.classList.remove('active');
      content.classList.add('hidden');
    });

    // Remove active class from all buttons
    document.querySelectorAll('.mode-button').forEach((button) => {
      button.classList.remove('active');
      button.setAttribute('aria-selected', 'false');
    });

    // Show selected tab
    const activeTab = document.getElementById(tabName);
    activeTab.classList.add('active');
    activeTab.classList.remove('hidden');

    // Mark button as active
    const activeButton = document.querySelector(`[data-tab="${tabName}"]`);
    activeButton.classList.add('active');
    activeButton.setAttribute('aria-selected', 'true');

    // Reset results
    this.resetForm(tabName);
  }

  resetForm(formName) {
    if (formName === 'pairing') {
      document.getElementById('pairingResult').classList.add('hidden');
      document.getElementById('pairingCodeDisplay').classList.add('hidden');
      document.getElementById('pairingInstructions').classList.add('hidden');
      document.getElementById('pairingError').classList.add('hidden');
      document.getElementById('phone').value = '';
    } else if (formName === 'qr') {
      document.getElementById('qrResult').classList.add('hidden');
      document.getElementById('qrCodeDisplay').classList.add('hidden');
      document.getElementById('qrInstructions').classList.add('hidden');
      document.getElementById('qrError').classList.add('hidden');
    }
  }

  async generatePairingSession() {
    if (this.pairingRequestInFlight || this.currentSessionId) return;

    const phone = document.getElementById('phone').value.trim();

    if (!phone) {
      this.showError('pairing', 'Please enter a phone number');
      return;
    }

    try {
      this.pairingRequestInFlight = true;
      this.setLoading('generatePairingBtn', true);
      document.getElementById('pairingResult').classList.remove('hidden');
      document.getElementById('pairingError').classList.add('hidden');

      const response = await fetch('/api/session/pair', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ phone })
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to generate pairing code');
      }

      this.currentSessionId = data.sessionId;
      this.currentMethod = 'pairing';
      this.pairingTtl = Math.max(1, data.expiresAt - data.createdAt);

      // Display pairing code
      document.getElementById('pairingCodeValue').textContent = data.pairingCode;
      document.getElementById('pairingCodeDisplay').classList.remove('hidden');
      document.getElementById('pairingInstructions').classList.remove('hidden');
      document.getElementById('newPairingBtn').classList.add('hidden');
      this.updatePairingStatus('Code ready — enter it in WhatsApp...', 'waiting');
      this.startPairingCountdown(data.expiresAt);

      // Start polling for status
      this.startPairingPolling(data.sessionId);
    } catch (error) {
      this.showError('pairing', error.message);
      document.getElementById('pairingResult').classList.add('hidden');
    } finally {
      this.pairingRequestInFlight = false;
      this.setLoading('generatePairingBtn', false);
      if (this.currentSessionId) {
        const button = document.getElementById('generatePairingBtn');
        button.disabled = true;
        button.innerHTML = '<i class="fa-solid fa-hourglass-half"></i><span>Pairing in progress</span>';
      }
    }
  }

  async generateQRSession() {
    try {
      this.setLoading('generateQRBtn', true);
      document.getElementById('qrResult').classList.remove('hidden');
      document.getElementById('qrError').classList.add('hidden');

      const response = await fetch('/api/session/qr', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        }
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to create QR session');
      }

      this.currentSessionId = data.sessionId;
      this.currentMethod = 'qr';

      this.updateQRStatus('Generating QR code...', 'waiting');
      document.getElementById('refreshQRBtn').classList.add('hidden');

      // Start polling for QR and status
      this.startQRPolling(data.sessionId);
    } catch (error) {
      this.showError('qr', error.message);
      document.getElementById('qrResult').classList.add('hidden');
    } finally {
      this.setLoading('generateQRBtn', false);
    }
  }

  startPairingPolling(sessionId) {
    this.stopPolling();
    let retryDelay = 2000;
    const poll = async () => {
      if (this.currentSessionId !== sessionId) return;
      try {
        const response = await fetch(`/api/session/status/${sessionId}`);
        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.error);
        }

        retryDelay = data.pollInterval || 2000;
        this.updatePairingCountdown(data.expiresAt, data.expiresIn);
        const status = data.status;

        // Update UI based on status
        if (status === 'paired' || status === 'retrying_pairing' || status === 'awaiting_pairing') {
          this.updatePairingStatus('Code ready — enter it in WhatsApp...', 'waiting');
        } else if (status === 'connected') {
          this.updatePairingStatus('🟢 WhatsApp Connected Successfully!', 'success');
          this.stopPolling();
          setTimeout(() => this.showSuccessScreen(sessionId), 1000);
        } else if (status === 'expired') {
          this.finishPairing('Pairing code expired.', true);
        } else if (status === 'failed' || status === 'logged_out' || status === 'cancelled') {
          this.finishPairing(data.error || 'Pairing failed. Please try again.', true);
        }
      } catch (error) {
        console.error('Polling error:', error);
        this.updatePairingStatus('Connection temporarily unavailable. Retrying...', 'waiting');
        retryDelay = Math.min(retryDelay * 2, 10000);
      }
      if (this.currentSessionId === sessionId) {
        this.pollingInterval = setTimeout(poll, retryDelay);
      }
    };
    poll();
  }

  startPairingCountdown(expiresAt) {
    this.stopCountdown();
    this.updatePairingCountdown(expiresAt);
    this.countdownInterval = setInterval(() => this.updatePairingCountdown(expiresAt), 250);
  }

  updatePairingCountdown(expiresAt, expiresIn) {
    if (!expiresAt) return;
    const remaining = Math.max(0, expiresIn ?? expiresAt - Date.now());
    const seconds = Math.ceil(remaining / 1000);
    const minutes = Math.floor(seconds / 60).toString().padStart(2, '0');
    const displaySeconds = (seconds % 60).toString().padStart(2, '0');
    const expiry = document.getElementById('pairingExpiry');
    const progress = document.getElementById('pairingExpiryProgress');
    if (expiry) expiry.textContent = `Expires in ${minutes}:${displaySeconds}`;
    if (progress) progress.style.transform = `scaleX(${Math.min(1, remaining / this.pairingTtl)})`;
  }

  stopCountdown() {
    if (this.countdownInterval) clearInterval(this.countdownInterval);
    this.countdownInterval = null;
  }

  finishPairing(message, allowNewCode = false) {
    this.stopPolling();
    this.stopCountdown();
    this.updatePairingStatus(message, 'error');
    document.getElementById('pairingCodeDisplay').classList.add('hidden');
    document.getElementById('pairingInstructions').classList.add('hidden');
    document.getElementById('pairingError').textContent = message;
    document.getElementById('pairingError').classList.remove('hidden');
    if (allowNewCode) document.getElementById('newPairingBtn').classList.remove('hidden');
    document.getElementById('generatePairingBtn').disabled = true;
  }

  startQRPolling(sessionId) {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
    }

    this.pollingInterval = setInterval(async () => {
      try {
        // Fetch QR code
        const qrResponse = await fetch(`/api/session/qr/${sessionId}`);

        if (qrResponse.ok) {
          const qrData = await qrResponse.json();
          this.displayQRCode(qrData.qr);
          document.getElementById('qrCodeDisplay').classList.remove('hidden');
          document.getElementById('qrInstructions').classList.remove('hidden');
          this.updateQRStatus('Scan the QR code with WhatsApp', 'waiting');
        }

        // Fetch status
        const statusResponse = await fetch(`/api/session/status/${sessionId}`);
        const statusData = await statusResponse.json();

        if (!statusResponse.ok) {
          throw new Error(statusData.error);
        }

        const status = statusData.status;

        if (status === 'qr' || status === 'reconnecting' || status === 'waiting_qr') {
          this.updateQRStatus('Scan the QR code with WhatsApp', 'waiting');
          document.getElementById('refreshQRBtn').classList.remove('hidden');
        } else if (status === 'connected') {
          this.updateQRStatus('🟢 WhatsApp Connected Successfully!', 'success');
          this.stopPolling();
          setTimeout(() => this.showSuccessScreen(sessionId), 1000);
        } else if (status === 'failed' || status === 'logged_out') {
          this.updateQRStatus('❌ Connection failed or logged out', 'error');
          this.stopPolling();
        }
      } catch (error) {
        console.error('Polling error:', error);
      }
    }, 2000);
  }

  displayQRCode(qrData) {
    const qrContainer = document.getElementById('qrCanvas');
    qrContainer.innerHTML = '';

    // Generate new QR code
    try {
      new QRCode(qrContainer, {
        text: qrData,
        width: 200,
        height: 200,
        correctLevel: QRCode.CorrectLevel.H
      });
    } catch (error) {
      qrContainer.textContent = 'QR code could not be rendered. Please refresh.';
      console.error('QR rendering error:', error);
    }
  }

  async refreshQRCode() {
    if (!this.currentSessionId) return;

    try {
      const response = await fetch(`/api/session/qr/${this.currentSessionId}`);
      const data = await response.json();

      if (response.ok && data.qr) {
        this.displayQRCode(data.qr);
      }
    } catch (error) {
      console.error('Error refreshing QR code:', error);
    }
  }

  updatePairingStatus(message, type = 'waiting') {
    const statusElement = document.getElementById('pairingStatus');
    const statusDot = document.querySelector('#pairing .status-line .status-dot');
    const indicator = document.querySelector('#pairing .status-line');

    statusElement.textContent = message;

    indicator.classList.remove('waiting', 'success', 'error');
    indicator.classList.add(type);

    if (type === 'success') {
      statusDot.textContent = '🟢';
    } else if (type === 'error') {
      statusDot.textContent = '🔴';
    } else {
      statusDot.textContent = '🟡';
    }
  }

  updateQRStatus(message, type = 'waiting') {
    const statusElement = document.getElementById('qrStatus');
    const statusDot = document.getElementById('qrStatusDot');
    const indicator = document.querySelector('#qr .status-line');

    statusElement.textContent = message;

    if (indicator) {
      indicator.classList.remove('waiting', 'success', 'error');
      indicator.classList.add(type);
    }

    if (type === 'success') {
      statusDot.textContent = '🟢';
    } else if (type === 'error') {
      statusDot.textContent = '🔴';
    } else {
      statusDot.textContent = '🟡';
    }
  }

  showError(method, message) {
    const errorElement =
      method === 'pairing' ? document.getElementById('pairingError') : document.getElementById('qrError');

    errorElement.textContent = message;
    errorElement.classList.remove('hidden');
  }

  copyToClipboard(elementId) {
    const element = document.getElementById(elementId);
    const text = element.textContent;

    navigator.clipboard
      .writeText(text)
      .then(() => {
        this.showCopyNotification('Pairing code for PrimeSA_Bot copied to clipboard!');
      })
      .catch((err) => {
        console.error('Failed to copy:', err);
      });
  }

  showCopyNotification(message) {
    const notification = document.createElement('div');
    notification.className = 'copied-notification';
    notification.textContent = message;

    document.body.appendChild(notification);

    setTimeout(() => {
      notification.remove();
    }, 3000);
  }

  showSuccessScreen(sessionId) {
    document.getElementById('successScreen').classList.remove('hidden');
    document.getElementById('successSessionId').textContent = sessionId;
    this.stopPolling();
  }

  resetToHome() {
    document.getElementById('successScreen').classList.add('hidden');
    this.resetForm('pairing');
    this.resetForm('qr');
    this.currentSessionId = null;
    this.currentMethod = null;
    this.stopCountdown();
    document.getElementById('newPairingBtn').classList.add('hidden');
    document.getElementById('generatePairingBtn').disabled = false;
    document.getElementById('generatePairingBtn').innerHTML = '<i class="fa-solid fa-bolt"></i><span>Generate Pair Code</span>';

    // Switch to pairing tab
    document.getElementById('pairing').classList.add('active');
    document.getElementById('qr').classList.remove('active');
    document.querySelectorAll('.mode-button')[0].classList.add('active');
    document.querySelectorAll('.mode-button')[0].setAttribute('aria-selected', 'true');
    document.querySelectorAll('.mode-button')[1].classList.remove('active');
    document.querySelectorAll('.mode-button')[1].setAttribute('aria-selected', 'false');
  }

  async cancelSession() {
    if (!this.currentSessionId) {
      this.resetToHome();
      return;
    }

    try {
      await fetch(`/api/session/${this.currentSessionId}`, {
        method: 'DELETE'
      });
    } catch (error) {
      console.error('Error canceling session:', error);
    }

    this.resetToHome();
  }

  stopPolling() {
    if (this.pollingInterval) {
      clearTimeout(this.pollingInterval);
      this.pollingInterval = null;
    }

    if (this.qrRefreshInterval) {
      clearInterval(this.qrRefreshInterval);
      this.qrRefreshInterval = null;
      this.countdownInterval = null;
      this.pairingRequestInFlight = false;
    }
  }

  setLoading(elementId, isLoading) {
    const element = document.getElementById(elementId);

    if (isLoading) {
      element.disabled = true;
      element.textContent = '⏳ Processing...';
    } else {
      element.disabled = false;
      if (elementId === 'generatePairingBtn') {
        element.textContent = 'Generate Pairing Code';
      } else if (elementId === 'generateQRBtn') {
        element.textContent = 'Generate QR Code';
      }
    }
  }
}

// Initialize app when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  new SessionApp();
});
