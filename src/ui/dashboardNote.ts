import { App, TFile, Notice } from 'obsidian';
import { GoogleDrivePluginSettings, SyncHistoryEntry } from '../types';

export interface DashboardDiffInfo {
  newFiles?: Array<{ path: string; size: number }>;
  modifiedFiles?: Array<{ path: string; size: number }>;
  deletedFiles?: Array<{ path: string }>;
  isSyncing?: boolean;
  syncProgress?: string;
}

export class DashboardNoteManager {
  public static readonly DASHBOARD_FILE = 'VaultGlide Dashboard.md';

  constructor(
    private app: App,
    private getSettings: () => GoogleDrivePluginSettings,
    private saveSettings: () => Promise<void>
  ) {}

  /**
   * Formats byte size into human readable string.
   */
  private formatBytes(bytes: number): string {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
  }

  /**
   * Returns human-formatted relative time.
   */
  private formatTimestamp(isoString: string | null): string {
    if (!isoString) return 'Never';
    try {
      const d = new Date(isoString);
      return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch {
      return isoString;
    }
  }

  /**
   * Scans local vault for statistics on markdown notes.
   */
  public getVaultStats(): { totalNotes: number; totalSize: number; totalFolders: number } {
    const files = this.app.vault.getFiles().filter((f) => f.extension === 'md' && f.name !== DashboardNoteManager.DASHBOARD_FILE);
    const totalNotes = files.length;
    const totalSize = files.reduce((acc, f) => acc + (f.stat?.size || 0), 0);
    const totalFolders = this.app.vault.getAllLoadedFiles().filter((f) => 'children' in f).length;

    return { totalNotes, totalSize, totalFolders };
  }

  /**
   * Generates formatted Markdown content for the VaultGlide Dashboard note.
   */
  public generateDashboardMarkdown(diff?: DashboardDiffInfo): string {
    const settings = this.getSettings();
    const stats = this.getVaultStats();

    const newFiles = diff?.newFiles || [];
    const modifiedFiles = diff?.modifiedFiles || [];
    const deletedFiles = diff?.deletedFiles || [];
    const totalPending = newFiles.length + modifiedFiles.length + deletedFiles.length;

    // Status Badge & Description
    let statusBadge = '🟢 **Up to Date**';
    let statusCalloutType = 'info';

    if (diff?.isSyncing) {
      statusBadge = `🔵 **Syncing in Progress...** (${diff.syncProgress || 'Transferring'})`;
      statusCalloutType = 'note';
    } else if (totalPending > 0) {
      statusBadge = `🟡 **${totalPending} Pending Change(s)** (Ready to Push)`;
      statusCalloutType = 'warning';
    } else if (settings.lastSyncStatus === 'offline') {
      statusBadge = '⚪ **Offline**';
      statusCalloutType = 'question';
    } else if (settings.lastSyncStatus === 'failed') {
      statusBadge = '🔴 **Last Sync Failed**';
      statusCalloutType = 'failure';
    }

    const lines: string[] = [];

    // Header
    lines.push('# 🚀 VaultGlide — Cloud Sync Dashboard\n');
    lines.push(`> [!${statusCalloutType}] **Cloud Sync Status**`);
    lines.push(`> - **Google Account:** ${settings.userEmail || 'Not Connected'}`);
    lines.push(`> - **Vault Name:** \`${settings.vaultName || 'DefaultVault'}\``);
    lines.push(`> - **Status:** ${statusBadge}`);
    lines.push(`> - **Last Synced:** ${this.formatTimestamp(settings.lastSyncTime)}\n`);

    // Interactive action block (processed by plugin codeblock processor)
    lines.push('```vaultglide-actions\n```\n');
    lines.push('---\n');

    // Section 1: Vault Statistics
    lines.push('## 📊 Vault Statistics\n');
    lines.push('| Metric | Value |');
    lines.push('| :--- | :--- |');
    lines.push(`| **Total Markdown Notes** | \`${stats.totalNotes} notes\` |`);
    lines.push(`| **Total Vault Size** | \`${this.formatBytes(stats.totalSize)}\` |`);
    lines.push(`| **Tracked Cloud Hashes** | \`${Object.keys(settings.syncedFileHashes || {}).length} files\` |`);
    lines.push(`| **Google Drive Folder ID** | \`${settings.vaultFolderId || 'Pending initial sync'}\` |\n`);

    lines.push('---\n');

    // Section 2: Pending Changes (Diff Inspector)
    lines.push('## 📋 Pending Changes (Local vs Google Drive)\n');

    if (totalPending === 0) {
      lines.push('✨ *All notes are completely synchronized with Google Drive. No pending uploads or deletions.*\n');
    } else {
      if (newFiles.length > 0) {
        lines.push(`### 🟢 New Notes to Upload (${newFiles.length})\n`);
        lines.push('| Note Path | Size | Action |');
        lines.push('| :--- | :--- | :--- |');
        for (const f of newFiles.slice(0, 25)) {
          lines.push(`| \`${f.path}\` | ${this.formatBytes(f.size)} | ➕ Upload to Drive |`);
        }
        if (newFiles.length > 25) {
          lines.push(`| *... and ${newFiles.length - 25} more notes* | | |`);
        }
        lines.push('');
      }

      if (modifiedFiles.length > 0) {
        lines.push(`### 🟡 Modified Notes (${modifiedFiles.length})\n`);
        lines.push('| Note Path | Size | Action |');
        lines.push('| :--- | :--- | :--- |');
        for (const f of modifiedFiles.slice(0, 25)) {
          lines.push(`| \`${f.path}\` | ${this.formatBytes(f.size)} | 🔄 Update on Drive |`);
        }
        if (modifiedFiles.length > 25) {
          lines.push(`| *... and ${modifiedFiles.length - 25} more notes* | | |`);
        }
        lines.push('');
      }

      if (deletedFiles.length > 0) {
        lines.push(`### 🔴 Deleted Notes to Trash (${deletedFiles.length})\n`);
        lines.push('| Note Path | Action |');
        lines.push('| :--- | :--- |');
        for (const f of deletedFiles.slice(0, 25)) {
          lines.push(`| \`${f.path}\` | 🗑️ Move to Drive Trash |`);
        }
        if (deletedFiles.length > 25) {
          lines.push(`| *... and ${deletedFiles.length - 25} more notes* | |`);
        }
        lines.push('');
      }
    }

    lines.push('---\n');

    // Section 3: Live Progress Meter
    lines.push('## ⚡ Live Sync Progress\n');
    if (diff?.isSyncing) {
      lines.push(`> 🔄 **Actively Syncing:** ${diff.syncProgress || 'Processing...'}\n`);
    } else {
      lines.push('> ⏳ **Idle** — Ready for manual Push or Pull.\n');
    }

    lines.push('---\n');

    // Section 4: Recent Sync History Log
    lines.push('## 📜 Recent Sync History\n');
    const history = settings.syncHistory || [];
    if (history.length === 0) {
      lines.push('*No sync sessions recorded yet.*\n');
    } else {
      lines.push('| Timestamp | Direction | Items | Result |');
      lines.push('| :--- | :--- | :--- | :--- |');
      for (const entry of history.slice(0, 10)) {
        const icon = entry.type === 'push' ? '⬆️ Push' : '⬇️ Pull';
        const resIcon = entry.status === 'success' ? '✅ Success' : `❌ Failed (${entry.error || 'Error'})`;
        lines.push(`| ${this.formatTimestamp(entry.timestamp)} | ${icon} | ${entry.filesCount} file(s) | ${resIcon} |`);
      }
      lines.push('');
    }

    lines.push('> [!tip] **Tip**\n> You can trigger sync anytime via the ribbon icons on the left, the command palette (`Ctrl/Cmd + P`), or the action buttons above.');

    return lines.join('\n');
  }

  /**
   * Writes the updated dashboard content to VaultGlide Dashboard.md.
   */
  public async writeDashboardNote(diff?: DashboardDiffInfo): Promise<void> {
    const content = this.generateDashboardMarkdown(diff);
    const path = DashboardNoteManager.DASHBOARD_FILE;

    try {
      const existing = this.app.vault.getAbstractFileByPath(path);
      if (existing instanceof TFile) {
        await this.app.vault.modify(existing, content);
      } else {
        await this.app.vault.create(path, content);
      }
    } catch (err) {
      // Direct adapter fallback
      try {
        await this.app.vault.adapter.write(path, content);
      } catch (adapterErr) {
        console.warn('Could not write VaultGlide Dashboard note:', adapterErr);
      }
    }
  }

  /**
   * Opens the dashboard note in an active or new leaf.
   */
  public async openDashboardNote(): Promise<void> {
    await this.writeDashboardNote();
    const file = this.app.vault.getAbstractFileByPath(DashboardNoteManager.DASHBOARD_FILE);
    if (file instanceof TFile) {
      const leaf = this.app.workspace.getLeaf(false);
      await leaf.openFile(file);
    }
  }

  /**
   * Appends an entry to the sync history ledger.
   */
  public async recordHistory(entry: SyncHistoryEntry): Promise<void> {
    const settings = this.getSettings();
    settings.syncHistory = settings.syncHistory || [];
    settings.syncHistory.unshift(entry);
    if (settings.syncHistory.length > 20) {
      settings.syncHistory = settings.syncHistory.slice(0, 20);
    }
    await this.saveSettings();
    await this.writeDashboardNote();
  }
}
