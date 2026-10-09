import { GDriveClient } from './gdriveClient';
import { RemoteDriveFile } from '../types';

export class FolderTreeManager {
  // In-memory cache mapping relative folder path (e.g. "Daily/Notes") -> Google Drive Folder ID
  private folderIdCache: Map<string, string> = new Map();
  // In-flight mutex locks preventing concurrent duplicate folder creation
  private inFlightFolderCreation: Map<string, Promise<string>> = new Map();

  constructor(
    private client: GDriveClient,
    private getVaultRootId: () => string,
    private setVaultRootId: (id: string) => Promise<void>,
    private getVaultName: () => string
  ) {}

  public clearCache(): void {
    this.folderIdCache.clear();
    this.inFlightFolderCreation.clear();
  }

  public getCachedFolderId(relativePath: string): string | undefined {
    const clean = relativePath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    return this.folderIdCache.get(clean);
  }

  /**
   * Returns a valid root vault folder ID, creating the My Drive/VaultGlide/<VaultName> folder
   * on Google Drive automatically if not already set.
   */
  public async getOrEnsureRootId(): Promise<string> {
    let rootId = this.getVaultRootId();
    if (rootId) return rootId;

    const vaultName = this.getVaultName() || 'DefaultVault';
    const { vaultFolderId } = await this.client.ensureVaultRootFolder(vaultName);
    await this.setVaultRootId(vaultFolderId);
    return vaultFolderId;
  }

  /**
   * Recursively resolves or creates the Google Drive folder hierarchy for a relative path.
   * Uses in-flight promise deduplication to guarantee zero duplicate folders during parallel file uploads.
   */
  public async ensureFolderPath(relativePath: string): Promise<string> {
    const rootId = await this.getOrEnsureRootId();

    const parts = relativePath.split('/').filter(Boolean);
    parts.pop(); // Remove filename to get folder segments

    if (parts.length === 0) {
      return rootId; // Root vault level
    }

    let currentParentId = rootId;
    let currentPath = '';

    for (const segment of parts) {
      currentPath = currentPath ? `${currentPath}/${segment}` : segment;

      // 1. Check existing resolved cache
      if (this.folderIdCache.has(currentPath)) {
        currentParentId = this.folderIdCache.get(currentPath)!;
        continue;
      }

      // 2. Check if another concurrent worker is already creating/resolving this folder
      if (this.inFlightFolderCreation.has(currentPath)) {
        currentParentId = await this.inFlightFolderCreation.get(currentPath)!;
        continue;
      }

      // 3. Create a deduplicated in-flight creation promise
      const creationPromise = this.resolveOrCreateSegment(segment, currentPath, currentParentId);
      this.inFlightFolderCreation.set(currentPath, creationPromise);

      try {
        currentParentId = await creationPromise;
      } finally {
        this.inFlightFolderCreation.delete(currentPath);
      }
    }

    return currentParentId;
  }

  private async resolveOrCreateSegment(
    segment: string,
    currentPath: string,
    parentId: string
  ): Promise<string> {
    // Check if it already exists remotely in parent
    const children = await this.client.listFolderChildren(parentId);
    const existingFolder = children.find(
      (c) => c.name === segment && c.mimeType === 'application/vnd.google-apps.folder'
    );

    if (existingFolder) {
      this.folderIdCache.set(currentPath, existingFolder.id);
      return existingFolder.id;
    }

    // Create single folder in Drive
    const newFolderId = await this.client.createFolder(segment, parentId);
    this.folderIdCache.set(currentPath, newFolderId);
    return newFolderId;
  }

  /**
   * Recursively scans and indexes all files in the remote vault folder into a flat Map<relativePath, RemoteDriveFile>.
   */
  public async scanRemoteVaultTree(rootFolderId: string): Promise<Map<string, RemoteDriveFile>> {
    const effectiveRootId = rootFolderId || (await this.getOrEnsureRootId());
    const fileMap = new Map<string, RemoteDriveFile>();

    const traverse = async (folderId: string, currentPathPrefix: string) => {
      const items = await this.client.listFolderChildren(folderId);

      for (const item of items) {
        const itemRelativePath = currentPathPrefix ? `${currentPathPrefix}/${item.name}` : item.name;

        if (item.mimeType === 'application/vnd.google-apps.folder') {
          this.folderIdCache.set(itemRelativePath, item.id);
          await traverse(item.id, itemRelativePath);
        } else {
          fileMap.set(itemRelativePath, item);
        }
      }
    };

    await traverse(effectiveRootId, '');
    return fileMap;
  }
}
