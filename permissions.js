// permissions.js
// Replacement for GM_setValue and GM_getValue with enhanced security

// Define allowed keys for storage operations to prevent IDOR vulnerabilities
const ALLOWED_KEYS = [
  'pond0xSwapAmount',
  'pond0xSwapCounter',
  'pond0xIsSwapping',
  'pond0xRetryInterval',
  'pond0xIsSwapRunning',
  'pond0xSwapReloaded',
  'pond0xIsAutoMode',
  'pond0xSwapMode',
  'pond0xIsRewardSwapsMode',
  'pond0xLastSwapDirection',
  'pond0xSelectedSellToken',
  'pond0xSelectedBuyToken',
  'pond0xLastSwapAmount',
  'pond0xLastIsSwapping',
  'pond0xSwapperIsPaused',
  'pond0xLastClaimTime',
  'pond0xReloadReason',
  'pond0xMinerIsPaused',
  'pond0xClaimCount',
  'pond0xTotalClaimed',
  'pond0xLastClaim',
  'pond0xPageReloads',
  'pond0xClaimTimes',
  'pond0xHistoricalClaims',
  'pond0xDailyClaims',
  'pond0xAutominerStarted',
  'pond0xWatchdogInterval',
  'pond0xClaimIntervalMinutes',
  'pond0xSmartClaimThreshold',
  'pond0xSmartClaimUnit',
  'pond0xIsSmartClaimEnabled',
  'pond0xIsClaimWaitMode',
  'pond0xLastResetDate',
  'pond0xCsrfToken',
  'encryptionKey' // Added for storing the encryption key
];

// Define sensitive keys that require encryption
const SENSITIVE_KEYS = [
  'pond0xSwapAmount',
  'pond0xSwapCounter',
  'pond0xTotalClaimed',
  'pond0xLastClaim',
  'pond0xHistoricalClaims',
  'pond0xDailyClaims'
];

// Validate key against whitelist to prevent unauthorized access
const validateKey = (key, lh) => {
  if (!ALLOWED_KEYS.includes(key)) {
    console.error(`${lh} - Invalid key: ${key}. Aborting storage operation.`);
    return false;
  }
  return true;
};

// Encryption utility to secure sensitive data
const encryptData = async (data, key) => {
  const encoder = new TextEncoder();
  const encodedData = encoder.encode(JSON.stringify(data));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encodedData
  );
  return { iv: Array.from(iv), data: Array.from(new Uint8Array(encrypted)) };
};

// Decryption utility to retrieve sensitive data
const decryptData = async (encrypted, key) => {
  const iv = new Uint8Array(encrypted.iv);
  const data = new Uint8Array(encrypted.data);
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    data
  );
  const decoder = new TextDecoder();
  return JSON.parse(decoder.decode(decrypted));
};

// Generate or retrieve encryption key on script load
let encryptionKey = null;
(async () => {
  const storedKey = await new Promise((resolve) => {
    chrome.storage.local.get(['encryptionKey'], (result) => {
      if (chrome.runtime.lastError) {
        console.error('[Permissions] - Error retrieving encryption key:', chrome.runtime.lastError);
        resolve(null);
      } else {
        resolve(result.encryptionKey);
      }
    });
  });
  if (storedKey) {
    encryptionKey = await crypto.subtle.importKey(
      'raw',
      new Uint8Array(storedKey),
      { name: 'AES-GCM' },
      false,
      ['encrypt', 'decrypt']
    );
    console.log('[Permissions] - Encryption key loaded from storage');
  } else {
    encryptionKey = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt']
    );
    const exportedKey = await crypto.subtle.exportKey('raw', encryptionKey);
    chrome.storage.local.set({ encryptionKey: Array.from(new Uint8Array(exportedKey)) }, () => {
      if (chrome.runtime.lastError) {
        console.error('[Permissions] - Error storing encryption key:', chrome.runtime.lastError);
      } else {
        console.log('[Permissions] - Encryption key generated and stored');
      }
    });
  }
})();

// Updated GM object with security enhancements
const GM = {
  getValue: async (key, defaultValue) => {
    return new Promise((resolve) => {
      // Validate the key against the whitelist
      if (!validateKey(key, '[Permissions]')) {
        resolve(defaultValue);
        return;
      }

      chrome.storage.local.get([key], async (result) => {
        if (chrome.runtime.lastError) {
          console.error(`[Permissions] - Error in GM.getValue for ${key}: ${chrome.runtime.lastError}`);
          resolve(defaultValue);
          return;
        }

        let value = result[key] !== undefined ? result[key] : defaultValue;
        // Decrypt sensitive data if necessary
        if (SENSITIVE_KEYS.includes(key) && result[key] && typeof result[key] === 'object' && result[key].iv) {
          try {
            value = await decryptData(result[key], encryptionKey);
            console.log(`[Permissions] - Decrypted value for ${key}`);
          } catch (e) {
            console.error(`[Permissions] - Decryption failed for ${key}: ${e.message}`);
            resolve(defaultValue);
            return;
          }
        }
        resolve(value);
      });
    });
  },

  setValue: async (key, value) => {
    return new Promise((resolve) => {
      // Validate the key against the whitelist
      if (!validateKey(key, '[Permissions]')) {
        resolve(false);
        return;
      }

      let dataToStore = value;
      // Encrypt sensitive data if necessary
      if (SENSITIVE_KEYS.includes(key)) {
        encryptData(value, encryptionKey).then((encrypted) => {
          chrome.storage.local.set({ [key]: encrypted }, () => {
            if (chrome.runtime.lastError) {
              console.error(`[Permissions] - Error in GM.setValue for ${key}: ${chrome.runtime.lastError}`);
              resolve(false);
            } else {
              console.log(`[Permissions] - Encrypted and stored value for ${key}`);
              resolve(true);
            }
          });
        }).catch((e) => {
          console.error(`[Permissions] - Encryption failed for ${key}: ${e.message}`);
          resolve(false);
        });
      } else {
        chrome.storage.local.set({ [key]: dataToStore }, () => {
          if (chrome.runtime.lastError) {
            console.error(`[Permissions] - Error in GM.setValue for ${key}: ${chrome.runtime.lastError}`);
            resolve(false);
          } else {
            console.log(`[Permissions] - Stored value for ${key}`);
            resolve(true);
          }
        });
      }
    });
  }
};

// Throttling variables for notifyUser
let lastNotificationTime = 0;
const NOTIFICATION_INTERVAL = 20000; // 20 seconds

// Replacement for notifications with throttling
function notifyUser(title, body) {
  const now = Date.now();
  if (now - lastNotificationTime < NOTIFICATION_INTERVAL) {
    console.log(`[Permissions] - Notification throttled to avoid overload: ${title} - ${body}`);
    return;
  }
  lastNotificationTime = now;
  chrome.runtime.sendMessage({ type: 'notify', title, body });
}