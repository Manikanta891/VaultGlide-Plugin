export interface GoogleDrivePluginSettings {
  serverRelayUrl: string;
  accessToken: string;
  refreshToken: string;
  tokenExpiry: number;
  userEmail: string;
  vaultName: string;
  vaultFolderId: string;
  deviceId: string;
  lastSyncTime: string | null;
  lastSyncStatus: 'up-to-date' | 'local-changes' | 'cloud-newer' | 'syncing' | 'failed' | 'offline' | 'unauthenticated';
  customIgnoredPatterns: string[];
  pendingOfflineChanges: string[];
  pendingDeletedPaths: string[];
  syncedFileHashes: Record<string, string>;
  // .obsidian configuration and plugin sync toggles
  syncConfigDir: boolean;
  syncCoreSettings: boolean;
  syncAppearance: boolean;
  syncCommunityPlugins: boolean;
  syncWorkspaceLayout: boolean;
}

export const DEFAULT_SETTINGS: GoogleDrivePluginSettings = {
  serverRelayUrl: 'https://obsidian-gdrive-backend.onrender.com',
  accessToken: '',
  refreshToken: '',
  tokenExpiry: 0,
  userEmail: '',
  vaultName: 'DefaultVault',
  vaultFolderId: '',
  deviceId: `device_${Math.random().toString(36).substring(2, 9)}`,
  lastSyncTime: null,
  lastSyncStatus: 'unauthenticated',
  customIgnoredPatterns: [],
  pendingOfflineChanges: [],
  pendingDeletedPaths: [],
  syncedFileHashes: {},
  syncConfigDir: true,
  syncCoreSettings: true,
  syncAppearance: true,
  syncCommunityPlugins: true,
  syncWorkspaceLayout: false,
};

export interface LocalFileHash {
  relativePath: string;
  hash: string;
  size: number;
  mtime: number;
}

export interface RemoteDriveFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  modifiedTime?: string;
  md5Checksum?: string;
  parents?: string[];
}

export interface SyncDiffResult {
  toUpload: LocalFileHash[];
  toDownload: RemoteDriveFile[];
  conflicts: Array<{
    relativePath: string;
    remoteFile: RemoteDriveFile;
    localFile: LocalFileHash;
  }>;
  status: 'up-to-date' | 'local-changes' | 'cloud-newer';
}
