import { requestUrl, RequestUrlParam } from 'obsidian';
import { GDriveAuth } from './gdriveAuth';
import { RemoteDriveFile } from '../types';

function escapeDriveQuery(str: string): string {
  return str.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

export type UploadProgressCallback = (uploadedBytes: number, totalBytes: number) => void;

export const RESUMABLE_UPLOAD_THRESHOLD = 5 * 1024 * 1024; // 5 MB: Files > 5 MB use Google Drive Resumable Upload
const CHUNK_SIZE = 2 * 1024 * 1024; // 2 MB (2,097,152 bytes = 8 * 256 KB, required multiple of 256 KB)

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
        throw: false,
      });

      // Handle Token Expired (401 or 403 Forbidden)
      if ((response.status === 401 || response.status === 403) && retryCount === 0) {
        const refreshed = await this.auth.refreshAccessToken();
        if (refreshed) {
          return this.request<T>(url, options, retryCount + 1);
        }
      }

      // Handle Rate Limits (429 Too Many Requests) with Exponential Backoff
      if ((response.status === 429 || response.status === 503) && retryCount < 3) {
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
    } catch (err: any) {
      if (retryCount === 0 && (err.message?.includes('401') || err.message?.includes('403'))) {
        const refreshed = await this.auth.refreshAccessToken();
        if (refreshed) {
          return this.request<T>(url, options, retryCount + 1);
        }
      }

      // Check if it's a DNS / network connectivity issue (common on Android mobile during network handover)
      const isNetworkError =
        err.message?.includes('UnknownHostException') ||
        err.message?.includes('ENOTFOUND') ||
        err.message?.includes('ECONNRESET') ||
        err.message?.includes('ETIMEDOUT') ||
        err.message?.includes('Failed to fetch') ||
        err.message?.includes('Network Error');

      if (isNetworkError && retryCount < 2) {
        const delay = (retryCount + 1) * 1500;
        await new Promise((resolve) => setTimeout(resolve, delay));
        return this.request<T>(url, options, retryCount + 1);
      }

      if (isNetworkError) {
        throw new Error('NETWORK_OFFLINE: Unable to reach Google Drive (DNS / network offline). Please check your internet connection.');
      }

      throw err;
    }
  }

  /**
   * Finds or creates the visible 'VaultGlide/<vaultName>' folder in the user's Google Drive.
   * Prevents duplicate root folders across reconnects.
   */
  public async ensureVaultRootFolder(vaultName: string): Promise<{ rootFolderId: string; vaultFolderId: string }> {
    const sanitizedVaultName = vaultName.trim().replace(/[\/\\:*?"<>|]/g, '_') || 'DefaultVault';
    const escapedVaultName = escapeDriveQuery(sanitizedVaultName);

    // 1. Check or create parent "VaultGlide" (with backwards compatibility for ObsidianSync)
    const rootQuery = await this.request<{ files: RemoteDriveFile[] }>(
      `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(
        "(name = 'VaultGlide' or name = 'ObsidianSync') and mimeType = 'application/vnd.google-apps.folder' and trashed = false"
      )}&fields=files(id,name,createdTime)&orderBy=createdTime asc`
    );

    let rootFolderId: string;
    if (rootQuery.json?.files && rootQuery.json.files.length > 0) {
      const primaryFolder = rootQuery.json.files.find((f) => f.name === 'VaultGlide');
      rootFolderId = primaryFolder?.id || rootQuery.json.files[0].id;
    } else {
      rootFolderId = await this.createFolder('VaultGlide', 'root');
    }

    // 2. Check or create vault subfolder
    const vaultQuery = await this.request<{ files: RemoteDriveFile[] }>(
      `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(
        `name = '${escapedVaultName}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false and '${rootFolderId}' in parents`
      )}&fields=files(id,name,createdTime)&orderBy=createdTime asc`
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
   * Uploads a new file (including 0-byte empty files and large media/videos) to Google Drive.
   * - Files <= 5 MB: Fast multipart upload.
   * - Files > 5 MB: Resumable chunked upload (prevents mobile OOM & handles network interruption).
   */
  public async uploadNewFile(
    name: string,
    parentId: string,
    mimeType: string,
    data: ArrayBuffer | Uint8Array,
    onProgress?: UploadProgressCallback
  ): Promise<RemoteDriveFile> {
    const dataBytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    if (dataBytes.byteLength > RESUMABLE_UPLOAD_THRESHOLD) {
      return this.uploadResumable(name, parentId, mimeType, dataBytes, false, onProgress);
    }
    return this.uploadMultipart(name, parentId, mimeType, dataBytes);
  }

  /**
   * Updates an existing file's content in Google Drive.
   * - Files <= 5 MB: Direct media PATCH.
   * - Files > 5 MB: Resumable chunked upload.
   */
  public async updateFileContent(
    fileId: string,
    mimeType: string,
    data: ArrayBuffer | Uint8Array,
    onProgress?: UploadProgressCallback
  ): Promise<RemoteDriveFile> {
    const dataBytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    if (dataBytes.byteLength > RESUMABLE_UPLOAD_THRESHOLD) {
      return this.uploadResumable('', fileId, mimeType, dataBytes, true, onProgress);
    }
    return this.updateMediaDirect(fileId, mimeType, dataBytes);
  }

  /**
   * Fast Multipart upload for files <= 5 MB.
   */
  private async uploadMultipart(
    name: string,
    parentId: string,
    mimeType: string,
    data: Uint8Array
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
    combined.set(data, offset);
    offset += data.byteLength;
    combined.set(closeBuffer, offset);

    const url = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart';
    const res = await this.request<RemoteDriveFile>(url, {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/related; boundary=${boundary}`,
      },
      body: combined.buffer.slice(combined.byteOffset, combined.byteOffset + combined.byteLength),
    });

    return res.json!;
  }

  /**
   * Direct Media PATCH for files <= 5 MB.
   */
  private async updateMediaDirect(
    fileId: string,
    mimeType: string,
    data: Uint8Array
  ): Promise<RemoteDriveFile> {
    const url = `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`;
    const res = await this.request<RemoteDriveFile>(url, {
      method: 'PATCH',
      headers: {
        'Content-Type': mimeType || 'application/octet-stream',
      },
      body: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer,
    });

    return res.json!;
  }

  /**
   * Resumable Chunked Upload Protocol for large files & video:
   * 1. Initiates resumable session with Google Drive.
   * 2. Streams the file in 2 MB chunks (multiples of 256 KB).
   * 3. Queries status and resumes upload seamlessly if any chunk drops.
   */
  private async uploadResumable(
    name: string,
    targetId: string,
    mimeType: string,
    data: Uint8Array,
    isUpdate: boolean,
    onProgress?: UploadProgressCallback
  ): Promise<RemoteDriveFile> {
    const token = await this.auth.getValidAccessToken();
    const totalBytes = data.byteLength;
    const finalMime = mimeType || 'application/octet-stream';

    // Step 1: Initiate Resumable Upload Session
    const initUrl = isUpdate
      ? `https://www.googleapis.com/upload/drive/v3/files/${targetId}?uploadType=resumable`
      : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable';

    const metadata = isUpdate
      ? {}
      : {
          name,
          parents: [targetId],
          mimeType: finalMime,
        };

    const initRes = await requestUrl({
      url: initUrl,
      method: isUpdate ? 'PATCH' : 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': finalMime,
        'X-Upload-Content-Length': totalBytes.toString(),
      },
      body: JSON.stringify(metadata),
      throw: false,
    });

    if (initRes.status >= 400) {
      throw new Error(`Failed to initiate resumable upload session (HTTP ${initRes.status}): ${initRes.text || ''}`);
    }

    const sessionUri = initRes.headers['location'] || initRes.headers['Location'];
    if (!sessionUri) {
      throw new Error('Google Drive did not return a resumable session URI.');
    }

    // Step 2: Stream Chunks in 2 MB segments
    let start = 0;
    let lastResult: RemoteDriveFile | null = null;

    while (start < totalBytes) {
      const end = Math.min(start + CHUNK_SIZE - 1, totalBytes - 1);
      const chunkLength = end - start + 1;
      const chunkBytes = data.slice(start, end + 1);
      const chunkBuffer = chunkBytes.buffer.slice(chunkBytes.byteOffset, chunkBytes.byteOffset + chunkBytes.byteLength);

      let chunkSuccess = false;
      let retryCount = 0;

      while (!chunkSuccess && retryCount < 4) {
        try {
          const chunkRes = await requestUrl({
            url: sessionUri,
            method: 'PUT',
            headers: {
              'Content-Range': `bytes ${start}-${end}/${totalBytes}`,
              'Content-Length': chunkLength.toString(),
            },
            body: chunkBuffer,
            throw: false,
          });

          if (chunkRes.status === 308) {
            // Intermediate chunk accepted by Google Drive (Resume Incomplete)
            chunkSuccess = true;
            start = end + 1;
            if (onProgress) onProgress(start, totalBytes);
          } else if (chunkRes.status === 200 || chunkRes.status === 201) {
            // Final chunk complete!
            chunkSuccess = true;
            lastResult = chunkRes.json as RemoteDriveFile;
            start = totalBytes;
            if (onProgress) onProgress(totalBytes, totalBytes);
          } else if (chunkRes.status >= 500 || chunkRes.status === 429) {
            // Server error or rate limit -> query status and resume
            retryCount++;
            const delay = Math.pow(2, retryCount) * 1000 + Math.random() * 500;
            await new Promise((r) => setTimeout(r, delay));
            const resumedStart = await this.queryResumableStatus(sessionUri, totalBytes);
            if (resumedStart !== null) {
              start = resumedStart;
              break;
            }
          } else {
            throw new Error(`Resumable chunk upload failed (HTTP ${chunkRes.status}): ${chunkRes.text || ''}`);
          }
        } catch (err: any) {
          retryCount++;
          if (retryCount >= 4) throw err;
          const delay = Math.pow(2, retryCount) * 1500;
          await new Promise((r) => setTimeout(r, delay));
          const resumedStart = await this.queryResumableStatus(sessionUri, totalBytes);
          if (resumedStart !== null) {
            start = resumedStart;
            break;
          }
        }
      }

      if (!chunkSuccess && start < totalBytes) {
        throw new Error(`Failed to upload chunk starting at byte ${start} after multiple retries.`);
      }
    }

    if (!lastResult) {
      const checkRes = await this.request<RemoteDriveFile>(
        `https://www.googleapis.com/drive/v3/files/${isUpdate ? targetId : 'root'}?fields=id,name,mimeType,size,modifiedTime`
      );
      return checkRes.json!;
    }

    return lastResult;
  }

  /**
   * Queries Google Drive for the last byte successfully received in an interrupted resumable session.
   */
  private async queryResumableStatus(sessionUri: string, totalBytes: number): Promise<number | null> {
    try {
      const res = await requestUrl({
        url: sessionUri,
        method: 'PUT',
        headers: {
          'Content-Range': `bytes */${totalBytes}`,
        },
        body: new ArrayBuffer(0),
        throw: false,
      });

      if (res.status === 308) {
        const rangeHeader = res.headers['range'] || res.headers['Range'];
        if (rangeHeader) {
          const match = /bytes=0-(\d+)/.exec(rangeHeader);
          if (match && match[1]) {
            return parseInt(match[1], 10) + 1;
          }
        }
        return 0;
      }
      return null;
    } catch {
      return null;
    }
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
