# Obsidian Google Drive Sync — Community Plugin

> Privacy-first, zero-background-daemon manual cloud sync between Obsidian and your personal Google Drive storage.

---

## 🌟 Key Highlights

- **Zero Third-Party Storage**: Notes stream directly between your device and your personal Google Drive (`My Drive/VaultGlide/`).
- **Explicit Manual Control**:
  - 🔵 **Push Symbol**: Upload local vault notes and media to Google Drive.
  - 🟢 **Pull Symbol**: Download latest notes from Google Drive to your device.
- **Battery-Friendly**: No battery-draining background sync daemons or timers.
- **Cross-Platform**: Runs natively on Obsidian Desktop (Windows, macOS, Linux) and Mobile (Android, iOS).
- **Fast 6-Digit Device Pairing**: Pair mobile devices in seconds with an ephemeral 6-digit code or QR code.

---

## 🛠️ Installation

### Method 1: Automatic 1-Click Installer (Desktop & Android)
1. Open the [Web Dashboard](https://your-frontend.vercel.app).
2. Connect your Google Account and select your Vault.
3. Click **"Select Local Vault Folder"** and pick your Obsidian vault. All plugin files are written automatically!

### Method 2: Manual Installation
1. Download the latest release from the [Releases](https://github.com/Manikanta891/obsidian-gdrive-plugin/releases) page.
2. Extract the files (`main.js`, `manifest.json`, `styles.css`) into `<Vault>/.obsidian/plugins/obsidian-google-drive-sync/`.
3. In Obsidian, go to **Settings ➔ Community plugins**:
   - If prompted, click **"Turn off restricted mode"**.
   - Click **Refresh (🔄)** under Installed plugins.
   - Toggle **ON** "Google Drive Sync".
4. You will see the **Push** (🔵) and **Pull** (🟢) icons appear in your left ribbon toolbar!

---

## 💻 Development & Build

```bash
# Install dependencies
npm install

# Build for production
npm run build

# Watch mode for active development
npm run dev
```
