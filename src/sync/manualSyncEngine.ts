import { App, Notice, TFile, TFolder } from 'obsidian';
import { GDriveClient } from '../gdrive/gdriveClient';
import { FolderTreeManager } from '../gdrive/folderTree';
import { LocalHasher } from './localHasher';
import { OfflineTracker } from './offlineTracker';
import { StatusBarController } from '../ui/statusBar';
import { ConfirmConflictModal } from '../ui/confirmModal';
import { GoogleDrivePluginSettings, LocalFileHash, RemoteDriveFile, SyncDiffResult } from '../types';

export class ManualSyncEngine {
  private hasher: LocalHasher;
  private folderTree: FolderTreeManager;

  constructor(
    private app: App,
    private getSettings: () => GoogleDrivePluginSettings,
    private loadSettings: () => Promise<void>,
    private saveSettings: () => Promise<void>,
    private client: GDriveClient,
    private offlineTracker: OfflineTracker,
    private statusBar: StatusBarController
  ) {
    this.hasher = new LocalHasher(app.vault, () => this.getSettings().customIgnoredPatterns);
    this.folderTree = new FolderTreeManager(
      client,
      () => this.getSettings().vaultFolderId,
      async (id: string) => {
        const settings = this.getSettings();
        settings.vaultFolderId = id;
        await this.saveSettings();
      },
      () => this.getSettings().vaultName
    );
  }

  /**
   * PUSH: High-Speed Parallel Upload of local vault changes directly to Google Drive.
   * Modifies existing files in-place with zero duplicate creations.
   */
  public async push(): Promise<void> {
    await this.loadSettings();
    const settings = this.getSettings();
    settings.syncedFileHashes = settings.syncedFileHashes || {};

    if (!settings.accessToken) {
      new Notice('Google Drive Sync: Please log in or pair device in plugin settings.');
      this.statusBar.setStatus('unauthenticated');
      return;
    }

    if (!navigator.onLine) {
      new Notice('Google Drive Sync: You are offline. Changes remain saved locally.');
      this.statusBar.setStatus('offline', `${settings.pendingOfflineChanges.length} pending`);
      return;
    }

    this.statusBar.setStatus('syncing', 'Scanning...');
    new Notice('Google Drive Sync: Checking vault changes...');

    try {
      // 1. Ensure root vault folder ID
      const rootFolderId = await this.folderTree.getOrEnsureRootId();

      // 2. Fast Parallel Scan: local vault & remote Drive tree
      const [localFiles, remoteMap] = await Promise.all([
        this.hasher.scanVault(),
        this.folderTree.scanRemoteVaultTree(rootFolderId),
      ]);

      // 3. Identify files that truly need upload (Accurate Hash Diffing)
      const toUpload: Array<{ local: LocalFileHash; remote?: RemoteDriveFile }> = [];

      for (const local of localFiles) {
        const cleanPath = local.relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
        const remote = remoteMap.get(cleanPath);

        if (!remote) {
          // New file -> Needs creation on Drive
          toUpload.push({ local });
        } else {
          const remoteSize = remote.size !== undefined ? parseInt(remote.size, 10) : 0;
          const cachedHash = settings.syncedFileHashes[cleanPath];

          // Check if file content actually changed
          if (cachedHash && cachedHash === local.hash && remoteSize === local.size) {
            // Unchanged file -> Skip upload
            continue;
          }

          if (remoteSize === local.size && !cachedHash) {
            // First time check: equal size, record hash and skip unless modified
            const remoteTime = remote.modifiedTime ? new Date(remote.modifiedTime).getTime() : 0;
            if (local.mtime <= remoteTime + 1000) {
              settings.syncedFileHashes[cleanPath] = local.hash;
              continue;
            }
          }

          // File modified -> Needs in-place update
          toUpload.push({ local, remote });
        }
      }

      if (toUpload.length === 0) {
        new Notice('Google Drive Sync: Everything is up to date. Nothing to push.');
        settings.lastSyncTime = new Date().toISOString();
        settings.lastSyncStatus = 'up-to-date';
        await this.saveSettings();
        await this.offlineTracker.clearPendingChanges();
        this.statusBar.setStatus('up-to-date');
        return;
      }

      // 4. Pre-pass: Warm up all unique folder IDs in parallel
      const uniqueFolders = Array.from(
        new Set(
          toUpload.map((item) => {
            const parts = item.local.relativePath.replace(/\\/g, '/').split('/').filter(Boolean);
            parts.pop();
            return parts.join('/');
          })
        )
      ).filter(Boolean);

      if (uniqueFolders.length > 0) {
        this.statusBar.setStatus('syncing', 'Preparing folders...');
        await Promise.all(uniqueFolders.map((p) => this.folderTree.ensureFolderPath(`${p}/placeholder.md`)));
      }

      // 5. High-Speed Upload via 10-Worker Parallel Stream
      let uploadedCount = 0;
      const total = toUpload.length;
      const CONCURRENCY_BATCH = 10;

      for (let i = 0; i < total; i += CONCURRENCY_BATCH) {
        const batch = toUpload.slice(i, i + CONCURRENCY_BATCH);

        await Promise.all(
          batch.map(async (item) => {
            const cleanPath = item.local.relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
            const abstractFile = this.app.vault.getAbstractFileByPath(item.local.relativePath);
            if (abstractFile instanceof TFile) {
              const binaryData = await this.app.vault.readBinary(abstractFile);
              const mimeType = this.getMimeType(cleanPath);

              if (item.remote) {
                // Update in-place (Modifies existing file ID, zero duplicate creation!)
                await this.client.updateFileContent(item.remote.id, mimeType, binaryData);
              } else {
                // Upload new file
                const parentFolderId = await this.folderTree.ensureFolderPath(cleanPath);
                const filename = cleanPath.split('/').pop()!;
                await this.client.uploadNewFile(filename, parentFolderId, mimeType, binaryData);
              }

              settings.syncedFileHashes[cleanPath] = item.local.hash;
              uploadedCount++;
              this.statusBar.setStatus('syncing', `${uploadedCount}/${total}`);
            }
          })
        );
      }

      // 6. Update sync state & persist synced hashes
      settings.lastSyncTime = new Date().toISOString();
      settings.lastSyncStatus = 'up-to-date';
      await this.saveSettings();
      await this.offlineTracker.clearPendingChanges();
      this.statusBar.setStatus('up-to-date');

      new Notice(`Google Drive Sync: Successfully pushed ${uploadedCount} file(s) to Drive!`);
    } catch (err) {
      console.error('Push Error:', err);
      settings.lastSyncStatus = 'failed';
      await this.saveSettings();
      this.statusBar.setStatus('failed');
      new Notice(`Google Drive Push failed: ${(err as Error).message}`);
    }
  }

  /**
   * PULL: Downloads cloud vault changes directly from Google Drive.
   */
  public async pull(): Promise<void> {
    await this.loadSettings();
    const settings = this.getSettings();
    settings.syncedFileHashes = settings.syncedFileHashes || {};

    if (!settings.accessToken) {
      new Notice('Google Drive Sync: Please log in or pair device in plugin settings.');
      this.statusBar.setStatus('unauthenticated');
      return;
    }

    if (!navigator.onLine) {
      new Notice('Google Drive Sync: You are offline.');
      this.statusBar.setStatus('offline');
      return;
    }

    this.statusBar.setStatus('syncing', 'Scanning cloud...');
    new Notice('Google Drive Sync: Checking Google Drive for changes...');

    try {
      const rootFolderId = await this.folderTree.getOrEnsureRootId();
      const [localFiles, remoteMap] = await Promise.all([
        this.hasher.scanVault(),
        this.folderTree.scanRemoteVaultTree(rootFolderId),
      ]);

      const localMap = new Map<string, LocalFileHash>();
      for (const lf of localFiles) {
        localMap.set(lf.relativePath.replace(/\\/g, '/').replace(/^\/+/, ''), lf);
      }

      const toDownload: RemoteDriveFile[] = [];

      for (const [remotePath, remoteFile] of remoteMap.entries()) {
        const local = localMap.get(remotePath);
        const remoteSize = remoteFile.size !== undefined ? parseInt(remoteFile.size, 10) : 0;
        const cachedHash = settings.syncedFileHashes[remotePath];

        if (!local) {
          toDownload.push(remoteFile);
        } else if (remoteSize !== local.size) {
          toDownload.push(remoteFile);
        }
      }

      if (toDownload.length === 0) {
        new Notice('Google Drive Sync: Your vault is already up to date with Google Drive.');
        settings.lastSyncTime = new Date().toISOString();
        settings.lastSyncStatus = 'up-to-date';
        await this.saveSettings();
        this.statusBar.setStatus('up-to-date');
        return;
      }

      let downloadedCount = 0;
      const total = toDownload.length;

      for (const remoteFile of toDownload) {
        const relPath = this.getRelativePathForRemote(remoteFile, remoteMap);
        const data = await this.client.downloadFileContent(remoteFile.id);

        await this.ensureLocalParentDir(relPath);
        const existing = this.app.vault.getAbstractFileByPath(relPath);

        if (existing instanceof TFile) {
          await this.app.vault.modifyBinary(existing, data);
        } else {
          await this.app.vault.createBinary(relPath, data);
        }

        const newHash = await this.hasher.computeHash(data);
        settings.syncedFileHashes[relPath] = newHash;

        downloadedCount++;
        this.statusBar.setStatus('syncing', `Pulling ${downloadedCount}/${total}`);
      }

      settings.lastSyncTime = new Date().toISOString();
      settings.lastSyncStatus = 'up-to-date';
      await this.saveSettings();
      this.statusBar.setStatus('up-to-date');

      new Notice(`Google Drive Sync: Successfully downloaded ${downloadedCount} note(s)!`);
    } catch (err) {
      console.error('Pull Error:', err);
      settings.lastSyncStatus = 'failed';
      await this.saveSettings();
      this.statusBar.setStatus('failed');
      new Notice(`Google Drive Pull failed: ${(err as Error).message}`);
    }
  }

  private getRelativePathForRemote(
    targetFile: RemoteDriveFile,
    remoteMap: Map<string, RemoteDriveFile>
  ): string {
    for (const [path, file] of remoteMap.entries()) {
      if (file.id === targetFile.id) return path;
    }
    return targetFile.name;
  }

  private async ensureLocalParentDir(relativePath: string): Promise<void> {
    const parts = relativePath.replace(/\\/g, '/').split('/').filter(Boolean);
    parts.pop();
    if (parts.length === 0) return;

    let current = '';
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      const exists = this.app.vault.getAbstractFileByPath(current);
      if (!exists) {
        try {
          await this.app.vault.createFolder(current);
        } catch {}
      }
    }
  }

  private getMimeType(path: string): string {
    if (path.endsWith('.md')) return 'text/markdown; charset=UTF-8';
    if (path.endsWith('.png')) return 'image/png';
    if (path.endsWith('.jpg') || path.endsWith('.jpeg')) return 'image/jpeg';
    if (path.endsWith('.pdf')) return 'application/pdf';
    if (path.endsWith('.json') || path.endsWith('.canvas')) return 'application/json';
    return 'application/octet-stream';
  }
}
