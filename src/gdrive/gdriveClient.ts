import { requestUrl, RequestUrlParam } from 'obsidian';
import { GDriveAuth } from './gdriveAuth';
import { RemoteDriveFile } from '../types';

export class GDriveClient {
  constructor(private auth: GDriveAuth) {}

  /**
   * Executes a direct request to Google Drive API v3 with automatic retry on 401/403 (token expiration)
   * and exponential backoff retry on 429 (rate limits).
   */
  private async request<T>(
    url: string,
    options: Partial<RequestUrlParam> = {},
    retryCount = 0
  ): Promise<{ status: number; json?: T; arrayBuffer?: ArrayBuffer; text?: string }> {
    const token = await this.auth.getValidAccessToken();

    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      ...(options.headers || {}),
    };

    try {
      const response = await requestUrl({
        url,
        method: options.method || 'GET',
        headers,
        body: options.body,
        throwResponseError: false,
      });

      // Handle Token Expired (401 or 403 Forbidden)
      if ((response.status === 401 || response.status === 403) && retryCount === 0) {
        const refreshed = await this.auth.refreshAccessToken();
        if (refreshed) {
          return this.request<T>(url, options, retryCount + 1);
        }
      }

      // Handle Rate Limits (429 Too Many Requests) with Exponential Backoff
      if (response.status === 429 && retryCount < 3) {
        const delay = Math.pow(2, retryCount) * 1000 + Math.random() * 500;
        await new Promise((resolve) => setTimeout(resolve, delay));
        return this.request<T>(url, options, retryCount + 1);
      }

      if (response.status >= 400) {
        const errorJson = response.json || {};
        const errorMsg = errorJson.error?.message || `Google Drive HTTP ${response.status}`;
        throw new Error(errorMsg);
      }

      return response as any;
    } catch (err) {
      if (retryCount === 0 && ((err as Error).message.includes('401') || (err as Error).message.includes('403'))) {
        const refreshed = await this.auth.refreshAccessToken();
        if (refreshed) {
          return this.request<T>(url, options, retryCount + 1);
        }
      }
      throw err;
    }
  }

  /**
   * Finds or creates the visible 'ObsidianSync/<vaultName>' folder in the user's Google Drive.
   */
  public async ensureVaultRootFolder(vaultName: string): Promise<{ rootFolderId: string; vaultFolderId: string }> {
    const sanitizedVaultName = vaultName.trim().replace(/[\/\\:*?"<>|]/g, '_') || 'DefaultVault';

    // 1. Check or create parent "ObsidianSync"
    const rootQuery = await this.request<{ files: RemoteDriveFile[] }>(
      `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(
        "name = 'ObsidianSync' and mimeType = 'application/vnd.google-apps.folder' and trashed = false and 'root' in parents"
      )}&fields=files(id,name)`
    );

    let rootFolderId: string;
    if (rootQuery.json?.files && rootQuery.json.files.length > 0) {
      rootFolderId = rootQuery.json.files[0].id;
    } else {
      rootFolderId = await this.createFolder('ObsidianSync', 'root');
    }

    // 2. Check or create vault subfolder
    const vaultQuery = await this.request<{ files: RemoteDriveFile[] }>(
      `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(
        `name = '${sanitizedVaultName}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false and '${rootFolderId}' in parents`
      )}&fields=files(id,name)`
    );

    let vaultFolderId: string;
    if (vaultQuery.json?.files && vaultQuery.json.files.length > 0) {
      vaultFolderId = vaultQuery.json.files[0].id;
    } else {
      vaultFolderId = await this.createFolder(sanitizedVaultName, rootFolderId);
    }

    return { rootFolderId, vaultFolderId };
  }

  /**
   * Fetches metadata for all non-trashed files and folders inside a given parent folder.
   */
  public async listFolderChildren(folderId: string): Promise<RemoteDriveFile[]> {
    if (!folderId) return [];
    const q = `'${folderId}' in parents and trashed = false`;
    const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(
      q
    )}&fields=files(id,name,mimeType,size,modifiedTime,md5Checksum,parents)&pageSize=1000`;

    const res = await this.request<{ files: RemoteDriveFile[] }>(url);
    return res.json?.files || [];
  }

  /**
   * Creates a subfolder in Google Drive.
   */
  public async createFolder(name: string, parentId: string): Promise<string> {
    const url = 'https://www.googleapis.com/drive/v3/files';
    const body = JSON.stringify({
      name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentId],
    });

    const res = await this.request<{ id: string }>(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });

    return res.json!.id;
  }

  /**
   * Uploads a new file (including 0-byte empty files) to Google Drive via multipart upload.
   */
  public async uploadNewFile(
    name: string,
    parentId: string,
    mimeType: string,
    data: ArrayBuffer
  ): Promise<RemoteDriveFile> {
    const metadata = {
      name,
      parents: [parentId],
      mimeType: mimeType || 'text/markdown',
    };

    const boundary = '-------314159265358979323846';
    const delimiter = `\r\n--${boundary}\r\n`;
    const closeDelimiter = `\r\n--${boundary}--`;

    const metadataPart = `${delimiter}Content-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(
      metadata
    )}\r\n`;
    const mediaHeader = `${delimiter}Content-Type: ${mimeType || 'application/octet-stream'}\r\n\r\n`;

    const metaBuffer = new TextEncoder().encode(metadataPart);
    const mediaHeaderBuffer = new TextEncoder().encode(mediaHeader);
    const closeBuffer = new TextEncoder().encode(closeDelimiter);

    // Combine multipart buffers cleanly
    const combinedLength = metaBuffer.byteLength + mediaHeaderBuffer.byteLength + data.byteLength + closeBuffer.byteLength;
    const combined = new Uint8Array(combinedLength);

    let offset = 0;
    combined.set(metaBuffer, offset);
    offset += metaBuffer.byteLength;
    combined.set(mediaHeaderBuffer, offset);
    offset += mediaHeaderBuffer.byteLength;
    combined.set(new Uint8Array(data), offset);
    offset += data.byteLength;
    combined.set(closeBuffer, offset);

    const url = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart';
    const res = await this.request<RemoteDriveFile>(url, {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/related; boundary=${boundary}`,
      },
      body: combined.buffer,
    });

    return res.json!;
  }

  /**
   * Updates an existing file's content in Google Drive (media PATCH).
   * Seamlessly handles file modifications and appends.
   */
  public async updateFileContent(fileId: string, mimeType: string, data: ArrayBuffer): Promise<RemoteDriveFile> {
    const url = `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`;
    const res = await this.request<RemoteDriveFile>(url, {
      method: 'PATCH',
      headers: {
        'Content-Type': mimeType || 'application/octet-stream',
      },
      body: data,
    });

    return res.json!;
  }

  /**
   * Downloads binary file data directly from Google Drive into an ArrayBuffer.
   */
  public async downloadFileContent(fileId: string): Promise<ArrayBuffer> {
    const url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
    const res = await this.request<any>(url, { method: 'GET' });
    return res.arrayBuffer || new ArrayBuffer(0);
  }

  /**
   * Moves a file or folder to Google Drive Trash.
   */
  public async trashFile(fileId: string): Promise<void> {
    const url = `https://www.googleapis.com/drive/v3/files/${fileId}`;
    await this.request(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trashed: true }),
    });
  }
}
