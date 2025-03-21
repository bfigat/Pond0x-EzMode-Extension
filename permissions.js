// permissions.js
// Replacement for GM_setValue and GM_getValue
const GM = {
    setValue: async (key, value) => {
        return new Promise((resolve) => {
            chrome.storage.local.set({ [key]: value }, () => resolve());
        });
    },
    getValue: async (key, defaultValue) => {
        return new Promise((resolve) => {
            chrome.storage.local.get([key], (result) => {
                resolve(result[key] !== undefined ? result[key] : defaultValue);
            });
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