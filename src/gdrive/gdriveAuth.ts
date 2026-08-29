import { requestUrl } from 'obsidian';
import { GoogleDrivePluginSettings } from '../types';

export class GDriveAuth {
  constructor(
    private getSettings: () => GoogleDrivePluginSettings,
    private saveSettings: () => Promise<void>
  ) {}

  /**
   * Returns a valid access token. If token is near expiration (within 5 minutes) or expired,
   * automatically triggers a proactive refresh before returning.
   */
  public async getValidAccessToken(): Promise<string> {
    const settings = this.getSettings();
    if (!settings.accessToken) {
      throw new Error('Google Drive is not authenticated. Please log in or enter a pairing code in plugin settings.');
    }

    const now = Date.now();
    const isExpiringSoon = settings.tokenExpiry && now >= settings.tokenExpiry - 5 * 60 * 1000;

    if (isExpiringSoon && settings.refreshToken) {
      await this.refreshAccessToken();
    }

    return this.getSettings().accessToken;
  }

  /**
   * Refreshes the Google OAuth access token using the stored refresh_token.
   */
  public async refreshAccessToken(): Promise<boolean> {
    const settings = this.getSettings();
    if (!settings.refreshToken) return false;

    try {
      const relayUrl = settings.serverRelayUrl.replace(/\/+$/, '');
      const response = await requestUrl({
        url: `${relayUrl}/api/auth/google/refresh`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: settings.refreshToken }),
        throwResponseError: false,
      });

      if (response.status === 200) {
        const data = response.json;
        settings.accessToken = data.accessToken;
        if (data.expiryDate) {
          settings.tokenExpiry = data.expiryDate;
        } else {
          settings.tokenExpiry = Date.now() + 3600 * 1000; // 1 hour default
        }
        await this.saveSettings();
        return true;
      }
    } catch (err) {
      console.warn('Failed to refresh Google OAuth token:', err);
    }
    return false;
  }

  /**
   * Redeems a 6-digit pairing code to link this device.
   */
  public async redeemPairingCode(code: string): Promise<boolean> {
    const settings = this.getSettings();
    const relayUrl = settings.serverRelayUrl.replace(/\/+$/, '');

    const response = await requestUrl({
      url: `${relayUrl}/api/pair/${encodeURIComponent(code.trim())}`,
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
      throwResponseError: false,
    });

    if (response.status === 200) {
      const data = response.json;
      settings.accessToken = data.accessToken;
      if (data.refreshToken) settings.refreshToken = data.refreshToken;
      if (data.expiryDate) settings.tokenExpiry = data.expiryDate;
      if (data.userEmail) settings.userEmail = data.userEmail;
      if (data.vaultName) settings.vaultName = data.vaultName;
      if (data.vaultFolderId) settings.vaultFolderId = data.vaultFolderId;

      settings.lastSyncStatus = 'up-to-date';
      await this.saveSettings();
      return true;
    }

    const errorJson = response.json || {};
    throw new Error(errorJson.error || `Pairing failed (HTTP ${response.status})`);
  }

  /**
   * Generates a 6-digit pairing code on this device to share with another device.
   */
  public async createPairingCode(): Promise<{ code: string; expiresInSeconds: number }> {
    const settings = this.getSettings();
    const relayUrl = settings.serverRelayUrl.replace(/\/+$/, '');

    const response = await requestUrl({
      url: `${relayUrl}/api/pair/create`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        vaultName: settings.vaultName || 'MyVault',
        vaultFolderId: settings.vaultFolderId,
        accessToken: settings.accessToken,
        refreshToken: settings.refreshToken,
        expiryDate: settings.tokenExpiry,
        userEmail: settings.userEmail,
      }),
      throwResponseError: false,
    });

    if (response.status === 201) {
      return response.json;
    }

    const err = response.json || {};
    throw new Error(err.error || 'Failed to generate pairing code');
  }
}
