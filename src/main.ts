import { Plugin, Notice } from 'obsidian';
import { DEFAULT_SETTINGS, GoogleDrivePluginSettings } from './types';
import { GDriveAuth } from './gdrive/gdriveAuth';
import { GDriveClient } from './gdrive/gdriveClient';
import { OfflineTracker } from './sync/offlineTracker';
import { ManualSyncEngine } from './sync/manualSyncEngine';
import { StatusBarController } from './ui/statusBar';
import { GoogleDriveSettingTab } from './ui/settingsTab';

export default class GoogleDriveSyncPlugin extends Plugin {
  settings: GoogleDrivePluginSettings = DEFAULT_SETTINGS;
  auth!: GDriveAuth;
  client!: GDriveClient;
  syncEngine!: ManualSyncEngine;
  offlineTracker!: OfflineTracker;
  statusBar!: StatusBarController;

  async onload() {
    await this.loadSettings();

    // 1. Initialize Status Bar
    const statusBarEl = this.addStatusBarItem();
    this.statusBar = new StatusBarController(statusBarEl);
    this.statusBar.setStatus(this.settings.lastSyncStatus);

    // 2. Initialize Auth & Clients
    this.auth = new GDriveAuth(
      () => this.settings,
      () => this.saveSettings()
    );
    this.client = new GDriveClient(this.auth);

    // 3. Initialize Offline Tracker
    this.offlineTracker = new OfflineTracker(
      () => this.settings,
      () => this.saveSettings(),
      (status) => {
        if (status === 'offline') {
          this.statusBar.setStatus('offline', `${this.settings.pendingOfflineChanges.length} pending`);
        } else {
          this.statusBar.setStatus(this.settings.lastSyncStatus);
        }
      }
    );

    // 4. Initialize Manual Sync Engine
    this.syncEngine = new ManualSyncEngine(
      this.app,
      () => this.settings,
      () => this.loadSettings(),
      () => this.saveSettings(),
      this.client,
      this.offlineTracker,
      this.statusBar
    );

    // 5. Track local file modifications for offline changes queue (ignored during sync)
    this.registerEvent(
      this.app.vault.on('modify', (file) => {
        if (this.syncEngine?.isSyncing) return;
        if (!navigator.onLine) {
          this.offlineTracker.trackFileModification(file.path);
          this.statusBar.setStatus('offline', `${this.settings.pendingOfflineChanges.length} pending`);
        } else if (this.settings.lastSyncStatus === 'up-to-date') {
          this.settings.lastSyncStatus = 'local-changes';
          this.statusBar.setStatus('local-changes');
        }
      })
    );

    this.registerEvent(
      this.app.vault.on('create', (file) => {
        if (this.syncEngine?.isSyncing) return;
        if (!navigator.onLine) {
          this.offlineTracker.trackFileModification(file.path);
        } else if (this.settings.lastSyncStatus === 'up-to-date') {
          this.settings.lastSyncStatus = 'local-changes';
          this.statusBar.setStatus('local-changes');
        }
      })
    );

    this.registerEvent(
      this.app.vault.on('delete', (file) => {
        if (this.syncEngine?.isSyncing) return;
        const cleanPath = file.path.replace(/\\/g, '/').replace(/^\/+/, '');
        this.offlineTracker.trackFileDeletion(cleanPath);
        if (this.settings.syncedFileHashes) {
          const folderPrefix = cleanPath.endsWith('/') ? cleanPath : `${cleanPath}/`;
          for (const trackedPath of Object.keys(this.settings.syncedFileHashes)) {
            if (trackedPath.startsWith(folderPrefix)) {
              this.offlineTracker.trackFileDeletion(trackedPath);
            }
          }
        }
        if (this.settings.lastSyncStatus === 'up-to-date') {
          this.settings.lastSyncStatus = 'local-changes';
          this.statusBar.setStatus('local-changes');
        }
      })
    );

    this.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => {
        if (this.syncEngine?.isSyncing) return;
        const cleanOld = oldPath.replace(/\\/g, '/').replace(/^\/+/, '');
        const cleanNew = file.path.replace(/\\/g, '/').replace(/^\/+/, '');
        this.offlineTracker.trackFileDeletion(cleanOld);
        this.offlineTracker.trackFileModification(cleanNew);
        if (this.settings.syncedFileHashes) {
          const folderOldPrefix = cleanOld.endsWith('/') ? cleanOld : `${cleanOld}/`;
          for (const trackedPath of Object.keys(this.settings.syncedFileHashes)) {
            if (trackedPath.startsWith(folderOldPrefix)) {
              this.offlineTracker.trackFileDeletion(trackedPath);
            }
          }
        }
        if (this.settings.lastSyncStatus === 'up-to-date') {
          this.settings.lastSyncStatus = 'local-changes';
          this.statusBar.setStatus('local-changes');
        }
      })
    );

    // 6. Register Ribbon Icons
    this.addRibbonIcon('gauge', 'VaultGlide Sync Dashboard', async () => {
      await this.syncEngine.openOrCreateDashboardFile();
    });

    this.addRibbonIcon('upload-cloud', 'Push to Google Drive', async () => {
      await this.syncEngine.push();
    });

    this.addRibbonIcon('download-cloud', 'Pull from Google Drive', async () => {
      await this.syncEngine.pull();
    });

    // 7. Register Commands (with optional hotkeys)
    this.addCommand({
      id: 'vaultglide-open-dashboard',
      name: 'Open Sync Dashboard',
      callback: async () => {
        await this.syncEngine.openOrCreateDashboardFile();
      },
    });

    this.addCommand({
      id: 'vaultglide-refresh-dashboard',
      name: 'Scan & Refresh Sync Dashboard',
      callback: async () => {
        await this.syncEngine.scanAndRefreshDashboard();
      },
    });

    this.addCommand({
      id: 'gdrive-push',
      name: 'Push vault to Google Drive',
      callback: async () => {
        await this.syncEngine.push();
      },
    });

    this.addCommand({
      id: 'gdrive-pull',
      name: 'Pull vault from Google Drive',
      callback: async () => {
        await this.syncEngine.pull();
      },
    });

    // 8. Register Interactive Dashboard Codeblock Processor
    this.registerMarkdownCodeBlockProcessor('vaultglide-actions', (source, el, ctx) => {
      el.empty();
      const bar = el.createDiv({ cls: 'vaultglide-actions-bar' });
      bar.style.display = 'flex';
      bar.style.flexWrap = 'wrap';
      bar.style.gap = '8px';
      bar.style.margin = '12px 0';

      const pushBtn = bar.createEl('button', {
        text: '⬆️ Push to Drive',
        cls: 'mod-cta',
      });
      pushBtn.style.padding = '8px 16px';
      pushBtn.style.fontWeight = 'bold';
      pushBtn.onclick = async () => {
        await this.syncEngine.push();
      };

      const pullBtn = bar.createEl('button', {
        text: '⬇️ Pull from Drive',
      });
      pullBtn.style.padding = '8px 16px';
      pullBtn.onclick = async () => {
        await this.syncEngine.pull();
      };

      const scanBtn = bar.createEl('button', {
        text: '🔄 Refresh & Scan',
      });
      scanBtn.style.padding = '8px 16px';
      scanBtn.onclick = async () => {
        await this.syncEngine.scanAndRefreshDashboard();
      };
    });

    // 9. Register Settings Tab
    this.addSettingTab(new GoogleDriveSettingTab(this.app, this));

    // Auto-initialize dashboard note on startup in background
    setTimeout(() => {
      this.syncEngine.dashboard.writeDashboardNote().catch(() => {});
    }, 1500);
  }

  async onunload() {
    // Cleanup on plugin unload
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}
