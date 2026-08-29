import { Notice } from 'obsidian';
import { GoogleDrivePluginSettings } from '../types';

export class OfflineTracker {
  private isOnline = navigator.onLine;

  constructor(
    private getSettings: () => GoogleDrivePluginSettings,
    private saveSettings: () => Promise<void>,
    private onStatusChange: (status: 'online' | 'offline') => void
  ) {
    this.registerEventListeners();
  }

  private registerEventListeners(): void {
    window.addEventListener('online', () => {
      this.isOnline = true;
      const settings = this.getSettings();
      const count = settings.pendingOfflineChanges.length;
      if (count > 0) {
        new Notice(`Google Drive Sync: Back online! ${count} local changes ready to push.`);
      }
      this.onStatusChange('online');
    });

    window.addEventListener('offline', () => {
      this.isOnline = false;
      this.onStatusChange('offline');
      new Notice('Google Drive Sync: Offline Mode. Your edits are saved safely on this device.');
    });
  }

  public getOnlineState(): boolean {
    return this.isOnline;
  }

  public async trackFileModification(path: string): Promise<void> {
    const settings = this.getSettings();
    if (!settings.pendingOfflineChanges.includes(path)) {
      settings.pendingOfflineChanges.push(path);
      await this.saveSettings();
    }
  }

  public async clearPendingChanges(): Promise<void> {
    const settings = this.getSettings();
    settings.pendingOfflineChanges = [];
    await this.saveSettings();
  }
}
