import { App, Notice, TFile, TFolder } from 'obsidian';
import { GDriveClient } from '../gdrive/gdriveClient';
import { FolderTreeManager } from '../gdrive/folderTree';
import { LocalHasher } from './localHasher';
import { OfflineTracker } from './offlineTracker';
import { StatusBarController } from '../ui/statusBar';
import { ConfirmConflictModal } from '../ui/confirmModal';
import { GoogleDrivePluginSettings, LocalFileHash, RemoteDriveFile, SyncDiffResult } from '../types';
import { isConfigDirFile, isPluginOrThemeFile } from './configSyncFilter';
import { DashboardNoteManager } from '../ui/dashboardNote';

export class ManualSyncEngine {
  private hasher: LocalHasher;
  private folderTree: FolderTreeManager;
  public dashboard: DashboardNoteManager;

  constructor(
    private app: App,
    private getSettings: () => GoogleDrivePluginSettings,
    private loadSettings: () => Promise<void>,
    private saveSettings: () => Promise<void>,
    private client: GDriveClient,
    private offlineTracker: OfflineTracker,
    private statusBar: StatusBarController
  ) {
    this.hasher = new LocalHasher(app.vault, () => this.getSettings());
    this.dashboard = new DashboardNoteManager(app, getSettings, saveSettings);
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

      // 3. Identify files that need upload (Accurate Hash Diffing)
      const toUpload: Array<{ local: LocalFileHash; remote?: RemoteDriveFile }> = [];
      const localPathSet = new Set<string>();

      for (const local of localFiles) {
        const cleanPath = local.relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
        localPathSet.add(cleanPath);
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

      // 4. Identify locally deleted files and folders that need trashing on Google Drive
      const deletedToTrash: Array<{ path: string; remoteFile: RemoteDriveFile }> = [];
      const pendingDeletions = new Set<string>(settings.pendingDeletedPaths || []);

      // Check any previously synced files that no longer exist locally
      for (const trackedPath of Object.keys(settings.syncedFileHashes)) {
        if (!localPathSet.has(trackedPath)) {
          pendingDeletions.add(trackedPath);
        }
      }

      const pendingDeletionList = Array.from(pendingDeletions);
      const lastSyncMs = settings.lastSyncTime ? new Date(settings.lastSyncTime).getTime() : 0;

      // Scan every remote file on Google Drive to see if it was deleted locally
      for (const [remotePath, remoteFile] of remoteMap.entries()) {
        if (this.hasher.isIgnored(remotePath)) {
          continue;
        }

        // If file is already present locally, it is not deleted
        if (localPathSet.has(remotePath)) {
          continue;
        }

        // Case 1: Explicitly deleted in Obsidian (matching file or parent folder)
        const isExplicitlyDeleted =
          pendingDeletions.has(remotePath) ||
          pendingDeletionList.some((p) => remotePath === p || remotePath.startsWith(p.endsWith('/') ? p : `${p}/`));

        // Case 2: Tracked in previous sync session and now missing locally
        const isPreviouslyTracked = remotePath in settings.syncedFileHashes;

        // Case 3: Existed on Drive during or before the previous sync session (modifiedTime <= lastSyncTime + 10s)
        const remoteModMs = remoteFile.modifiedTime ? new Date(remoteFile.modifiedTime).getTime() : 0;
        const existedAtLastSync = lastSyncMs > 0 && remoteModMs <= lastSyncMs + 10000;

        if (isExplicitlyDeleted || isPreviouslyTracked || existedAtLastSync) {
          deletedToTrash.push({ path: remotePath, remoteFile });
        }
      }

      // Check if any deleted folders should also be trashed on Google Drive
      const deletedFoldersToTrash: Array<{ path: string; folderId: string }> = [];
      for (const delPath of pendingDeletionList) {
        const folderId = this.folderTree.getCachedFolderId(delPath);
        if (folderId && !Array.from(localPathSet).some((lp) => lp.startsWith(delPath.endsWith('/') ? delPath : `${delPath}/`))) {
          deletedFoldersToTrash.push({ path: delPath, folderId });
        }
      }

      if (toUpload.length === 0 && deletedToTrash.length === 0 && deletedFoldersToTrash.length === 0) {
        new Notice('Google Drive Sync: Everything is up to date. Nothing to push.');
        settings.lastSyncTime = new Date().toISOString();
        settings.lastSyncStatus = 'up-to-date';
        await this.saveSettings();
        await this.offlineTracker.clearPendingChanges();
        this.statusBar.setStatus('up-to-date');
        return;
      }

      // 5. Execute Google Drive Trash for deleted files and folders
      let trashedCount = 0;
      if (deletedToTrash.length > 0 || deletedFoldersToTrash.length > 0) {
        const totalToDelete = deletedToTrash.length + deletedFoldersToTrash.length;
        this.statusBar.setStatus('syncing', `Trashing ${totalToDelete} item(s)...`);

        for (const item of deletedToTrash) {
          try {
            await this.client.trashFile(item.remoteFile.id);
            delete settings.syncedFileHashes[item.path];
            trashedCount++;
          } catch (delErr) {
            console.warn(`Could not trash remote file ${item.path}:`, delErr);
          }
        }

        for (const fItem of deletedFoldersToTrash) {
          try {
            await this.client.trashFile(fItem.folderId);
            trashedCount++;
          } catch (delErr) {
            console.warn(`Could not trash remote folder ${fItem.path}:`, delErr);
          }
        }

        // Clean up any stale tracked hashes that are no longer local or remote
        for (const trackedPath of Object.keys(settings.syncedFileHashes)) {
          if (!localPathSet.has(trackedPath) && !remoteMap.has(trackedPath)) {
            delete settings.syncedFileHashes[trackedPath];
          }
        }
      }

      // 6. Pre-pass: Warm up all unique folder IDs in parallel
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

      // 7. High-Speed Upload via 6-Worker Continuous Stream & Live Screen Notice
      let uploadedCount = 0;
      const total = toUpload.length;
      const queue = [...toUpload];
      const WORKER_COUNT = 6;

      let progressNotice: Notice | null = new Notice(`VaultGlide: Uploading 0/${total} notes...`, 0);

      const updatePushStatus = (currentFilename: string) => {
        const pct = Math.round((uploadedCount / total) * 100);
        this.statusBar.setStatus('syncing', `${uploadedCount}/${total} (${pct}%)`);
        if (progressNotice) {
          progressNotice.setMessage(`VaultGlide: [${uploadedCount}/${total}] ${currentFilename} (${pct}%)`);
        }
      };

      const workers = Array(Math.min(WORKER_COUNT, queue.length))
        .fill(0)
        .map(async () => {
          while (queue.length > 0) {
            const item = queue.shift();
            if (!item) break;

            const cleanPath = item.local.relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
            const filename = cleanPath.split('/').pop()!;
            updatePushStatus(filename);

            try {
              const binaryData = await this.readLocalFileBinary(cleanPath);
              if (binaryData) {
                const mimeType = this.getMimeType(cleanPath);

                if (item.remote) {
                  await this.client.updateFileContent(item.remote.id, mimeType, binaryData);
                } else {
                  const parentFolderId = await this.folderTree.ensureFolderPath(cleanPath);
                  await this.client.uploadNewFile(filename, parentFolderId, mimeType, binaryData);
                }

                settings.syncedFileHashes[cleanPath] = item.local.hash;
                uploadedCount++;
                updatePushStatus(filename);
              }
            } catch (itemErr) {
              console.warn(`Could not upload ${cleanPath}:`, itemErr);
            }
          }
        });

      await Promise.all(workers);

      if (progressNotice) {
        progressNotice.hide();
        progressNotice = null;
      }

      // 8. Update sync state & record history
      settings.lastSyncTime = new Date().toISOString();
      settings.lastSyncStatus = 'up-to-date';
      await this.saveSettings();
      await this.offlineTracker.clearPendingChanges();
      this.statusBar.setStatus('up-to-date');

      // Record in dashboard ledger and update dashboard file
      await this.dashboard.recordHistory({
        timestamp: new Date().toISOString(),
        type: 'push',
        filesCount: uploadedCount,
        trashedCount,
        status: 'success',
      });

      let noticeMsg = `Google Drive Sync: Successfully pushed ${uploadedCount} file(s) to Drive!`;
      if (uploadedCount > 0 && trashedCount > 0) {
        noticeMsg = `Google Drive Sync: Uploaded ${uploadedCount} file(s), moved ${trashedCount} deleted file(s) to Drive trash!`;
      } else if (trashedCount > 0) {
        noticeMsg = `Google Drive Sync: Moved ${trashedCount} deleted file(s) to Drive trash!`;
      }
      new Notice(noticeMsg);
    } catch (err: any) {
      const isOffline =
        err.message?.includes('NETWORK_OFFLINE') ||
        err.message?.includes('UnknownHostException') ||
        err.message?.includes('ENOTFOUND') ||
        err.message?.includes('Failed to fetch');

      if (isOffline) {
        settings.lastSyncStatus = 'offline';
        await this.saveSettings();
        this.statusBar.setStatus('offline');
        new Notice('Google Drive Sync: No internet connection. Please check your network and try again.');
        return;
      }

      console.error('Push Error:', err);
      settings.lastSyncStatus = 'failed';
      await this.saveSettings();
      this.statusBar.setStatus('failed');

      await this.dashboard.recordHistory({
        timestamp: new Date().toISOString(),
        type: 'push',
        filesCount: uploadedCount,
        status: 'failed',
        error: err.message,
      });

      new Notice(`Google Drive Push failed: ${err.message}`);
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

      // 1. Detect and safely trash local files that were deleted on Google Drive
      const remotePathSet = new Set(remoteMap.keys());
      let localTrashedCount = 0;
      const configDir = (this.app.vault as any).configDir || '.obsidian';

      for (const trackedPath of Object.keys(settings.syncedFileHashes)) {
        if (!remotePathSet.has(trackedPath) && localMap.has(trackedPath)) {
          // File was previously synced, exists locally, but was deleted on Google Drive
          if (!settings.pendingDeletedPaths || !settings.pendingDeletedPaths.includes(trackedPath)) {
            try {
              if (isConfigDirFile(trackedPath, configDir)) {
                if (await this.app.vault.adapter.exists(trackedPath)) {
                  await this.app.vault.adapter.remove(trackedPath);
                  delete settings.syncedFileHashes[trackedPath];
                  localTrashedCount++;
                }
              } else {
                const abstractFile = this.app.vault.getAbstractFileByPath(trackedPath);
                if (abstractFile instanceof TFile) {
                  await this.app.vault.trash(abstractFile, true); // Safe move to .trash
                  delete settings.syncedFileHashes[trackedPath];
                  localTrashedCount++;
                }
              }
            } catch (trashErr) {
              console.warn(`Could not trash local file ${trackedPath}:`, trashErr);
            }
          }
        }
      }

      // 2. Identify files that need download with accurate diffing
      const toDownload: RemoteDriveFile[] = [];

      for (const [remotePath, remoteFile] of remoteMap.entries()) {
        // Skip ignored files (e.g. non-synced config files, unselected plugins, blacklisted data.json)
        if (this.hasher.isIgnored(remotePath)) {
          continue;
        }

        const local = localMap.get(remotePath);
        const remoteSize = remoteFile.size !== undefined ? parseInt(remoteFile.size, 10) : 0;
        const cachedHash = settings.syncedFileHashes[remotePath];

        if (!local) {
          // Do not resurrect if deliberately deleted locally prior to push
          const isPendingDeleted =
            settings.pendingDeletedPaths &&
            settings.pendingDeletedPaths.some((p) => remotePath === p || remotePath.startsWith(p.endsWith('/') ? p : `${p}/`));

          if (isPendingDeleted) {
            continue;
          }
          toDownload.push(remoteFile);
        } else {
          const isSizeDifferent = remoteSize !== local.size;
          const remoteTime = remoteFile.modifiedTime ? new Date(remoteFile.modifiedTime).getTime() : 0;
          const isRemoteNewer = remoteTime > local.mtime + 2000;
          const isContentMismatch = cachedHash ? cachedHash !== local.hash : true;

          // Download if size changed, or if remote is newer and content doesn't match cached sync
          if (isSizeDifferent || (isRemoteNewer && isContentMismatch)) {
            toDownload.push(remoteFile);
          }
        }
      }

      if (toDownload.length === 0 && localTrashedCount === 0) {
        new Notice('Google Drive Sync: Your vault is already up to date with Google Drive.');
        settings.lastSyncTime = new Date().toISOString();
        settings.lastSyncStatus = 'up-to-date';
        await this.saveSettings();
        this.statusBar.setStatus('up-to-date');
        return;
      }

      let downloadedCount = 0;
      let hasUpdatedPluginsOrThemes = false;
      const total = toDownload.length;
      const queue = [...toDownload];
      const WORKER_COUNT = 6;

      let pullNotice: Notice | null = new Notice(`VaultGlide: Downloading 0/${total} notes...`, 0);

      const updatePullStatus = (currentFilename: string) => {
        const pct = Math.round((downloadedCount / total) * 100);
        this.statusBar.setStatus('syncing', `Pulling ${downloadedCount}/${total} (${pct}%)`);
        if (pullNotice) {
          pullNotice.setMessage(`VaultGlide: [${downloadedCount}/${total}] ${currentFilename} (${pct}%)`);
        }
      };

      const workers = Array(Math.min(WORKER_COUNT, queue.length))
        .fill(0)
        .map(async () => {
          while (queue.length > 0) {
            const remoteFile = queue.shift();
            if (!remoteFile) break;

            const relPath = this.getRelativePathForRemote(remoteFile, remoteMap);
            const filename = relPath.split('/').pop()!;
            updatePullStatus(filename);

            try {
              const data = await this.client.downloadFileContent(remoteFile.id);
              await this.writeLocalFileBinary(relPath, data);

              if (isPluginOrThemeFile(relPath, configDir)) {
                hasUpdatedPluginsOrThemes = true;
              }

              const newHash = await this.hasher.computeHash(data);
              settings.syncedFileHashes[relPath] = newHash;

              downloadedCount++;
              updatePullStatus(filename);
            } catch (dlErr) {
              console.warn(`Could not pull ${relPath}:`, dlErr);
            }
          }
        });

      await Promise.all(workers);

      if (pullNotice) {
        pullNotice.hide();
        pullNotice = null;
      }

      settings.lastSyncTime = new Date().toISOString();
      settings.lastSyncStatus = 'up-to-date';
      await this.saveSettings();
      this.statusBar.setStatus('up-to-date');

      await this.dashboard.recordHistory({
        timestamp: new Date().toISOString(),
        type: 'pull',
        filesCount: downloadedCount,
        status: 'success',
      });

      let pullMsg = `Google Drive Sync: Successfully downloaded ${downloadedCount} note(s)!`;
      if (downloadedCount > 0 && localTrashedCount > 0) {
        pullMsg = `Google Drive Sync: Downloaded ${downloadedCount} note(s), removed ${localTrashedCount} remote-deleted item(s).`;
      } else if (localTrashedCount > 0) {
        pullMsg = `Google Drive Sync: Removed ${localTrashedCount} remote-deleted item(s).`;
      }
      new Notice(pullMsg);

      if (hasUpdatedPluginsOrThemes) {
        new Notice('Google Drive Sync: Plugins or themes were updated. Reload Obsidian (Ctrl/Cmd + R) to activate them.', 8000);
      }
    } catch (err: any) {
      const isOffline =
        err.message?.includes('NETWORK_OFFLINE') ||
        err.message?.includes('UnknownHostException') ||
        err.message?.includes('ENOTFOUND') ||
        err.message?.includes('Failed to fetch');

      if (isOffline) {
        settings.lastSyncStatus = 'offline';
        await this.saveSettings();
        this.statusBar.setStatus('offline');
        new Notice('Google Drive Sync: No internet connection. Please check your network and try again.');
        return;
      }

      console.error('Pull Error:', err);
      settings.lastSyncStatus = 'failed';
      await this.saveSettings();
      this.statusBar.setStatus('failed');

      await this.dashboard.recordHistory({
        timestamp: new Date().toISOString(),
        type: 'pull',
        filesCount: downloadedCount,
        status: 'failed',
        error: err.message,
      });

      new Notice(`Google Drive Pull failed: ${err.message}`);
    }
  }

  /**
   * Safely reads binary content from either regular vault files or hidden .obsidian config files.
   */
  private async readLocalFileBinary(cleanPath: string): Promise<Uint8Array | null> {
    try {
      const configDir = (this.app.vault as any).configDir || '.obsidian';
      if (isConfigDirFile(cleanPath, configDir)) {
        const buffer = await this.app.vault.adapter.readBinary(cleanPath);
        return new Uint8Array(buffer);
      }

      const abstractFile = this.app.vault.getAbstractFileByPath(cleanPath);
      if (abstractFile instanceof TFile) {
        const buffer = await this.app.vault.readBinary(abstractFile);
        return new Uint8Array(buffer);
      }

      if (await this.app.vault.adapter.exists(cleanPath)) {
        const buffer = await this.app.vault.adapter.readBinary(cleanPath);
        return new Uint8Array(buffer);
      }

      return null;
    } catch (e) {
      console.warn(`Failed to read local binary file ${cleanPath}:`, e);
      return null;
    }
  }

  /**
   * Safely writes binary content to either regular vault files or hidden .obsidian config files.
   */
  private async writeLocalFileBinary(relativePath: string, data: Uint8Array | ArrayBuffer): Promise<void> {
    await this.ensureLocalParentDir(relativePath);
    const configDir = (this.app.vault as any).configDir || '.obsidian';
    const arrayBuffer: ArrayBuffer = (data instanceof Uint8Array
      ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
      : data) as ArrayBuffer;

    if (isConfigDirFile(relativePath, configDir)) {
      await this.app.vault.adapter.writeBinary(relativePath, arrayBuffer);
      return;
    }

    const existing = this.app.vault.getAbstractFileByPath(relativePath);
    if (existing instanceof TFile) {
      await this.app.vault.modifyBinary(existing, arrayBuffer);
    } else {
      try {
        await this.app.vault.createBinary(relativePath, arrayBuffer);
      } catch {
        // Fallback to adapter if vault API rejects (e.g. edge case path)
        await this.app.vault.adapter.writeBinary(relativePath, arrayBuffer);
      }
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

    const configDir = (this.app.vault as any).configDir || '.obsidian';
    let current = '';
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      const isConfig = isConfigDirFile(current, configDir);
      const exists = isConfig
        ? await this.app.vault.adapter.exists(current)
        : this.app.vault.getAbstractFileByPath(current) !== null;

      if (!exists) {
        try {
          if (isConfig) {
            await this.app.vault.adapter.mkdir(current);
          } else {
            await this.app.vault.createFolder(current);
          }
        } catch {
          try {
            await this.app.vault.adapter.mkdir(current);
          } catch {}
        }
      }
    }
  }

  private getMimeType(path: string): string {
    if (path.endsWith('.md')) return 'text/markdown; charset=UTF-8';
    if (path.endsWith('.png')) return 'image/png';
    if (path.endsWith('.jpg') || path.endsWith('.jpeg')) return 'image/jpeg';
    if (path.endsWith('.pdf')) return 'application/pdf';
    if (path.endsWith('.json') || path.endsWith('.canvas')) return 'application/json';
    if (path.endsWith('.css')) return 'text/css';
    if (path.endsWith('.js')) return 'application/javascript';
    return 'application/octet-stream';
  }

  /**
   * Scans local vault and remote Google Drive tree to update VaultGlide Dashboard.md
   * with pending new files, modified files, and deleted files.
   */
  public async scanAndRefreshDashboard(): Promise<void> {
    await this.loadSettings();
    const settings = this.getSettings();
    if (!settings.accessToken) {
      new Notice('VaultGlide: Please configure Google Drive in settings.');
      await this.dashboard.writeDashboardNote();
      return;
    }

    new Notice('VaultGlide: Scanning vault changes for dashboard...');
    try {
      const rootFolderId = await this.folderTree.getOrEnsureRootId();
      const [localFiles, remoteMap] = await Promise.all([
        this.hasher.scanVault(),
        this.folderTree.scanRemoteVaultTree(rootFolderId),
      ]);

      const newFiles: Array<{ path: string; size: number }> = [];
      const modifiedFiles: Array<{ path: string; size: number }> = [];
      const localPathSet = new Set<string>();

      for (const local of localFiles) {
        const cleanPath = local.relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
        localPathSet.add(cleanPath);
        const remote = remoteMap.get(cleanPath);

        if (!remote) {
          newFiles.push({ path: cleanPath, size: local.size });
        } else {
          const remoteSize = remote.size !== undefined ? parseInt(remote.size, 10) : 0;
          const cachedHash = settings.syncedFileHashes[cleanPath];
          if (cachedHash && cachedHash === local.hash && remoteSize === local.size) {
            continue;
          }
          modifiedFiles.push({ path: cleanPath, size: local.size });
        }
      }

      const deletedFiles: Array<{ path: string }> = [];
      for (const trackedPath of Object.keys(settings.syncedFileHashes || {})) {
        if (!localPathSet.has(trackedPath)) {
          deletedFiles.push({ path: trackedPath });
        }
      }

      await this.dashboard.writeDashboardNote({
        newFiles,
        modifiedFiles,
        deletedFiles,
        isSyncing: false,
      });

      new Notice(`VaultGlide Dashboard: ${newFiles.length} new, ${modifiedFiles.length} modified, ${deletedFiles.length} deleted.`);
    } catch (err: any) {
      console.warn('Dashboard scan error:', err);
      await this.dashboard.writeDashboardNote();
    }
  }

  /**
   * Opens the VaultGlide Dashboard.md note in the active workspace and triggers a background scan.
   */
  public async openOrCreateDashboardFile(): Promise<void> {
    await this.dashboard.openDashboardNote();
    this.scanAndRefreshDashboard().catch(() => {});
  }
}
