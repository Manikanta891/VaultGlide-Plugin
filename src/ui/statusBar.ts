import { GoogleDrivePluginSettings } from '../types';

export class StatusBarController {
  private statusBarEl: HTMLElement;

  constructor(statusBarEl: HTMLElement) {
    this.statusBarEl = statusBarEl;
  }

  public setStatus(
    state: GoogleDrivePluginSettings['lastSyncStatus'],
    extraInfo?: string | null
  ): void {
    let icon = '☁️';
    let text = 'Drive';

    switch (state) {
      case 'up-to-date':
        icon = '🟢';
        text = 'Drive: Up to date';
        break;
      case 'local-changes':
        icon = '🔵';
        text = 'Drive: Local Changes';
        break;
      case 'cloud-newer':
        icon = '🟡';
        text = 'Drive: Cloud Newer';
        break;
      case 'syncing':
        icon = '⏳';
        text = extraInfo ? `Drive: ${extraInfo}` : 'Drive: Syncing...';
        break;
      case 'offline':
        icon = '📡';
        text = extraInfo ? `Drive: Offline (${extraInfo})` : 'Drive: Offline';
        break;
      case 'failed':
        icon = '🔴';
        text = 'Drive: Sync Failed';
        break;
      case 'unauthenticated':
        icon = '⚪';
        text = 'Drive: Not Connected';
        break;
    }

    this.statusBarEl.setText(`${icon} ${text}`);
    this.statusBarEl.setAttribute('title', `Obsidian Google Drive Sync: ${text}`);
  }
}
