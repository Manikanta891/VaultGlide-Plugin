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

    const cloudRelay = 'https://obsidian-gdrive-backend.onrender.com';
    const urlsToTry: string[] = [];

    // If current setting is configured, try it first unless it's localhost on a non-desktop device
    if (settings.serverRelayUrl) {
      urlsToTry.push(settings.serverRelayUrl.replace(/\/+$/, ''));
    }
    if (!urlsToTry.includes(cloudRelay)) {
      urlsToTry.push(cloudRelay);
    }
    // If user's relay is localhost/127.0.0.1, prioritize cloudRelay first
    if (settings.serverRelayUrl?.includes('localhost') || settings.serverRelayUrl?.includes('127.0.0.1')) {
      urlsToTry.sort((a, b) => (a === cloudRelay ? -1 : 1));
    }

    for (const relayUrl of urlsToTry) {
      try {
        const response = await requestUrl({
          url: `${relayUrl}/api/auth/google/refresh`,
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken: settings.refreshToken }),
          throw: false,
        });

        if (response.status === 200 && response.json?.accessToken) {
          const data = response.json;
          settings.accessToken = data.accessToken;
          if (data.expiryDate) {
            settings.tokenExpiry = data.expiryDate;
          } else {
            settings.tokenExpiry = Date.now() + 3600 * 1000; // 1 hour default
          }
          // If the working URL was the cloud relay, upgrade the setting
          if (settings.serverRelayUrl?.includes('localhost') && relayUrl === cloudRelay) {
            settings.serverRelayUrl = cloudRelay;
          }
          await this.saveSettings();
          return true;
        }
      } catch (err) {
        console.warn(`Failed to refresh Google OAuth token via ${relayUrl}:`, err);
      }
    }
    return false;
  }

  /**
   * Redeems a 6-digit pairing code to link this device.
   */
  public async redeemPairingCode(code: string): Promise<boolean> {
    const settings = this.getSettings();
    const cloudRelay = 'https://obsidian-gdrive-backend.onrender.com';
    const urlsToTry: string[] = [];

    if (settings.serverRelayUrl) {
      urlsToTry.push(settings.serverRelayUrl.replace(/\/+$/, ''));
    }
    if (!urlsToTry.includes(cloudRelay)) {
      urlsToTry.push(cloudRelay);
    }
    if (settings.serverRelayUrl?.includes('localhost') || settings.serverRelayUrl?.includes('127.0.0.1')) {
      urlsToTry.sort((a, b) => (a === cloudRelay ? -1 : 1));
    }

    let lastError = 'Pairing failed';
    for (const relayUrl of urlsToTry) {
      try {
        const response = await requestUrl({
          url: `${relayUrl}/api/pair/${encodeURIComponent(code.trim())}`,
          method: 'GET',
          headers: { 'Content-Type': 'application/json' },
          throw: false,
        });

        if (response.status === 200 && response.json?.accessToken) {
          const data = response.json;
          settings.accessToken = data.accessToken;
          if (data.refreshToken) settings.refreshToken = data.refreshToken;
          if (data.expiryDate) settings.tokenExpiry = data.expiryDate;
          if (data.userEmail) settings.userEmail = data.userEmail;
          if (data.vaultName) settings.vaultName = data.vaultName;
          if (data.vaultFolderId) settings.vaultFolderId = data.vaultFolderId;
          settings.serverRelayUrl = relayUrl;
          settings.lastSyncStatus = 'up-to-date';
          await this.saveSettings();
          return true;
        } else if (response.status !== 404) {
          lastError = response.json?.error || `Pairing failed (HTTP ${response.status})`;
        }
      } catch (err: any) {
        lastError = err.message || 'Connection error';
      }
    }
    throw new Error(lastError);
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
      throw: false,
    });

    if (response.status === 201) {
      return response.json;
    }

    const err = response.json || {};
    throw new Error(err.error || 'Failed to generate pairing code');
  }
}
