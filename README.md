# Ez Mode - Pond0x Automation Extension

![Ez Mode Logo](icon48.png)

**Ez Mode** is a browser extension designed to automate mining and swapping activities on [Pond0x](https://www.pond0x.com/). With version 4.2.0, this extension provides a seamless experience for users looking to optimize their mining and swapping operations with minimal manual intervention. Featuring a user-friendly control panel, detailed status tracking, and smart automation features, Ez Mode is your go-to tool for efficient Pond0x interactions.

-  **Wallet interation**: Note the extension does not connect to your wallet, and does not create any non native Pond0x signatures or touch your private key or seed phrase. 

## Features

### Mining Automation
- **Auto-Mining**: Automatically starts mining sessions when the global mining status is active.
- **Smart Claiming**: Claims tokens based on a configurable threshold (e.g., 200M tokens) or when the hash rate drops to zero.
- **Claim + Wait Mode**: Mines, claims, waits 20 minutes, and repeats—perfect for consistent cycles.
- **Control Panel**: Toggle between Auto and Manual modes, pause/resume mining, and adjust settings like claim intervals and watchdog timers.
- **Status Monitoring**: Continuously checks the global mining status via a hidden tab and updates the user interface accordingly.
- **Summary Box**: Displays real-time stats including total claimed tokens, last claim, average claim time, and daily claim history.

### Swapping Automation
- **Auto-Swapping**: Automates token swaps on Pond0x's Solana swap page.
- **Swap Modes**:
  - **Boost Swaps**: Swaps 0.01 USDC for quick, low-value transactions.
  - **Reward Swaps**: Swaps 9.02 USDC (or USDT) in a USDC ↔ USDT cycle for higher-value rewards.
  - **Custom Swaps**: Allows users to set a custom swap amount.
- **Token Pair Selection**: Choose your sell and buy tokens (e.g., USDC, SOL, wPOND, USDT) with an easy dropdown interface.
- **Swap Frequency**: Adjust how often swaps occur (default: every 3 seconds).
- **Manifest Swaps Tracking**: Input your wallet address to fetch and display your manifest swaps.

### General Features
- **Notifications**: Receive alerts for mining status, claims, swaps, and errors.
- **Drag-and-Drop UI**: Move the control panel and summary box anywhere on the screen.
- **Stats Tracking**: Monitor claim counts, total claimed tokens, swap counts, and historical data.
- **Export History**: Export your claim history as a CSV file for record-keeping.
- **Error Handling**: Automatically reloads the page on detected crashes or stuck states to ensure continuous operation.

## Installation

### Prerequisites
- **Google Chromium Browser**: Ez Mode is a Chrome extension and requires Google Chrome,Brave,Firefox,Edge to function.
- **Pond0x Account**: You need an active Pond0x account and a connected wallet (e.g., Phantom) to interact with the mining and swapping features.
-  **Wallet interation**: Note the extension does not connect to your wallet, and does not create any non native Pond0x signatures or touch your private key or seed phrase. 

### Steps to Install

1. **Download Zipped Files**:
    Press code button in github to download the files as a zip for ez-mode

1. **Load the Extension in Chrome**:
- Open Chrome and go to `chrome://extensions/`.
- Enable “Developer mode” (toggle in the top-right corner).
- Click “Load unpacked” and select the `ez-mode` folder you cloned.

-Alternativley you can clone the repository

**Clone the Repository**:
    git clone https://github.com/[your-username]/ez-mode.git
   cd ez-mode

- Open Chrome and go to `chrome://extensions/`.
- Enable “Developer mode” (toggle in the top-right corner).
- Click “Load unpacked” and select the `ez-mode` folder you cloned.

2. **Verify Installation**:
- You should see the “Ez Mode” extension listed with the bear icon (as shown in the manifest: `icon48.png` and `icon128.png`).
- The extension will automatically activate when you visit `https://www.pond0x.com/mining` or `https://www.pond0x.com/swap/solana`.

-----

## Usage

### Mining on Pond0x

1. **Navigate to the Mining Page**:
- Go to `https://www.pond0x.com/mining`.
2. **Control Panel**:
- A control panel will appear in the top-right corner of the page.
- **Mode Toggle**: Switch between “Auto” (default) and “Manual” modes.
- **Start/Stop Mining**: Click “Start Auto Mining” (or “Start Manual Mining”) to begin. In Auto mode, the extension will check the global mining status and start mining when available.
- **Pause/Resume**: Pause or resume the automation process.
- **Claim + Wait Mode**: Enable this to mine, claim, wait 20 minutes, and repeat.
- **Settings**:
  - Adjust the **Watchdog Interval** (how often the script checks for inactivity).
  - Set the **Claim Interval** (maximum time before a claim is triggered).
  - Configure **Smart Claim** (claims when unclaimed tokens reach a threshold).
3. **Summary Box**:
- A draggable summary box will appear near the mining display, showing:
  - Date, number of claims, total claimed tokens, last claim amount, and more.
  - Daily claim history for the past 4 days.
  - Mining status (e.g., “Mining” or “Idle”) and global mining status (e.g., “Mining: Active”).
- Click “Stats Reset” to reset daily stats.
4. **Export History**:
- From the control panel, click “Export History” to download a CSV file with your claim history.

### Swapping on Pond0x

1. **Navigate to the Swap Page**:
- Go to `https://www.pond0x.com/swap/solana`.
2. **Control Panel**:
- A control panel will appear below the swap button.
- **Mode Toggle**: Switch between “Auto” (default) and “Manual” modes.
- **Start/Stop Swapping**: Click “Start Swapping” to begin.
- **Pause/Resume**: Pause or resume the swapping process.
- **Swap Modes**:
  - **Boost Swaps**: Set to 0.01 USDC for quick swaps.
  - **Reward Swaps**: Set to 9.02 USDC/USDT and alternates directions.
  - **Custom Swap**: Enter a custom amount.
- **Token Selection**: Choose the sell and buy tokens (e.g., USDC to SOL) and click “Update”.
- **Swap Frequency**: Adjust how often swaps occur (in seconds).
- **Wallet Address**: Enter your wallet address to fetch manifest swaps (displayed in the panel).
- **Stats Reset**: Reset the swap counter.
3. **Monitoring**:
- The panel shows the number of completed swaps and a log of recent actions.

-----

## Permissions

The extension requires the following permissions (as defined in `manifest.json`):

- **storage**: To save settings and claim/swap history.
- **notifications**: To send alerts for mining and swapping events.
- **tabs**: To open and manage hidden tabs for status polling and manifest scraping.
- **activeTab**: To interact with the current Pond0x page.
- **scripting**: To inject scripts into pages for automation.
- **host_permissions**:
  - `https://cary0x.github.io/status-mini/`: For polling global mining status.
  - `https://www.pond0x.com/*`: For automating mining and swapping.
  - `https://cary0x.github.io/docs/info/manifest`: For fetching manifest swaps.

-----

## Development

### Project Structure

```
ez-mode/
├── background.js         # Background script for notifications and tab management
├── content_autominer.js  # Script for mining automation
├── content_autoswapper.js # Script for swapping automation
├── icon48.png            # 48x48 icon for Chrome
├── icon128.png           # 128x128 icon for Chrome
├── manifest.json         # Extension manifest
├── README.md             # This file
└── screenshots/          # Folder for screenshots (add your own)
```

### Building and Testing

1. **Modify Code**:
- Edit the JavaScript files (`background.js`, `content_autominer.js`, `content_autoswapper.js`) as needed.
- Update the `manifest.json` if you add new permissions or content scripts.
2. **Reload Extension**:
- Go to `chrome://extensions/`, find “Ez Mode,” and click “Reload.”
3. **Test**:
- Visit `https://www.pond0x.com/mining` and `https://www.pond0x.com/swap/solana` to test the automation features.
- Check the console logs (`Ctrl+Shift+J`) for debugging.

-----

## Known Issues

- **Page Load Delays**: If the Pond0x page takes too long to load, the extension may timeout. It will attempt to proceed but some features might not work.
- **Invalid Unclaimed Values**: If the mining page shows invalid unclaimed values (e.g., “100k”, “1m”), the extension will reload the page to recover itself with no interation needed
- **Swap Button States**: If the swap button gets stuck (e.g., “loading…” or “pending”), the extension will reload the page after a timeout.
- **Network Issues**: The extension checks for network connectivity and reloads the page if disconnected.

-----

## Contributing

Contributions are welcome! If you’d like to contribute:

1. Fork the repository.
2. Create a new branch (`git checkout -b feature/your-feature`).
3. Make your changes and commit them (`git commit -m "Add your feature"`).
4. Push to your branch (`git push origin feature/your-feature`).
5. Open a Pull Request.

-----

## License

This project is licensed under the MIT License - see the <LICENSE> file for details.

*(Note: You’ll need to create a `LICENSE` file if you choose the MIT License or another license.)*

-----

## Acknowledgements

- Built with inspiration from the Pond0x community.
- Thanks to the xAI team for creating Grok, which assisted in generating this README.

-----

## Contact

For questions or support, please open an issue on GitHub or contact [Your Email or Social Handle].

-----

  
