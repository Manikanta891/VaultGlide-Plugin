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

    // 5. Track local file modifications for offline changes queue
    this.registerEvent(
      this.app.vault.on('modify', (file) => {
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
        if (!navigator.onLine) {
          this.offlineTracker.trackFileModification(file.path);
        } else if (this.settings.lastSyncStatus === 'up-to-date') {
          this.settings.lastSyncStatus = 'local-changes';
          this.statusBar.setStatus('local-changes');
        }
      })
    );

    // 6. Register Ribbon Icons
    this.addRibbonIcon('upload-cloud', 'Push to Google Drive', async () => {
      await this.syncEngine.push();
    });

    this.addRibbonIcon('download-cloud', 'Pull from Google Drive', async () => {
      await this.syncEngine.pull();
    });

    // 7. Register Commands (with optional hotkeys)
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

    // 8. Register Settings Tab
    this.addSettingTab(new GoogleDriveSettingTab(this.app, this));
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
