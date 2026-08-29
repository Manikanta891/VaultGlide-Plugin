import { App, PluginSettingTab, Setting, Notice } from 'obsidian';
import type GoogleDriveSyncPlugin from '../main';

export class GoogleDriveSettingTab extends PluginSettingTab {
  plugin: GoogleDriveSyncPlugin;
  private pairingCodeInput = '';

  constructor(app: App, plugin: GoogleDriveSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h2', { text: 'Google Drive Sync Settings' });
    containerEl.createEl('p', {
      text: 'Direct manual cloud synchronization for your vault using your personal Google Drive account. Zero third-party database storage.',
      cls: 'setting-item-description',
    });

    // 1. Connection Status Card
    new Setting(containerEl)
      .setName('Google Drive Status')
      .setDesc(
        this.plugin.settings.accessToken
          ? `Connected as ${this.plugin.settings.userEmail || 'Google User'} (Vault: My Drive/ObsidianSync/${this.plugin.settings.vaultName})`
          : 'Not connected to Google Drive'
      )
      .addButton((btn) => {
        if (this.plugin.settings.accessToken) {
          btn.setButtonText('Disconnect').setWarning().onClick(async () => {
            this.plugin.settings.accessToken = '';
            this.plugin.settings.refreshToken = '';
            this.plugin.settings.userEmail = '';
            this.plugin.settings.vaultFolderId = '';
            this.plugin.settings.lastSyncStatus = 'unauthenticated';
            await this.plugin.saveSettings();
            new Notice('Disconnected Google Drive');
            this.display();
          });
        } else {
          btn.setButtonText('Open Web Setup Wizard').setCta().onClick(() => {
            window.open(this.plugin.settings.serverRelayUrl || 'http://localhost:5173', '_blank');
          });
        }
      });

    // 2. 6-Digit Device Pairing Section
    containerEl.createEl('h3', { text: 'Device Pairing (Mobile ↔ Desktop)' });

    // Redeem a code generated on another device
    new Setting(containerEl)
      .setName('Enter 6-Digit Pair Code')
      .setDesc('Enter a code generated from your other device or web setup portal.')
      .addText((text) =>
        text
          .setPlaceholder('e.g. SYNC-849')
          .setValue(this.pairingCodeInput)
          .onChange((val) => (this.pairingCodeInput = val))
      )
      .addButton((btn) =>
        btn
          .setButtonText('Link Device')
          .setCta()
          .onClick(async () => {
            if (!this.pairingCodeInput.trim()) {
              new Notice('Please enter a 6-digit pairing code');
              return;
            }
            try {
              btn.setDisabled(true);
              await this.plugin.auth.redeemPairingCode(this.pairingCodeInput);
              new Notice('Device paired successfully with Google Drive!');
              this.display();
            } catch (err) {
              new Notice(`Pairing failed: ${(err as Error).message}`);
            } finally {
              btn.setDisabled(false);
            }
          })
      );

    // Generate code on this device to share with other devices
    if (this.plugin.settings.accessToken) {
      new Setting(containerEl)
        .setName('Generate Pairing Code for Another Device')
        .setDesc('Creates a temporary 10-minute 6-digit code you can enter on your other device.')
        .addButton((btn) =>
          btn.setButtonText('Generate Code').onClick(async () => {
            try {
              btn.setDisabled(true);
              const result = await this.plugin.auth.createPairingCode();
              new Notice(`Pairing Code: ${result.code} (Expires in 10 mins)`, 10000);
            } catch (err) {
              new Notice(`Failed to generate code: ${(err as Error).message}`);
            } finally {
              btn.setDisabled(false);
            }
          })
        );
    }

    // 3. Vault Configuration
    containerEl.createEl('h3', { text: 'Vault Configuration' });

    new Setting(containerEl)
      .setName('Vault Name')
      .setDesc('The subfolder name in Google Drive (My Drive/ObsidianSync/<VaultName>)')
      .addText((text) =>
        text
          .setPlaceholder('MyVault')
          .setValue(this.plugin.settings.vaultName)
          .onChange(async (value) => {
            this.plugin.settings.vaultName = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Pairing Relay / Server URL')
      .setDesc('Lightweight relay server URL for 1-time OAuth callback & pairing handshake.')
      .addText((text) =>
        text
          .setPlaceholder('http://localhost:5050')
          .setValue(this.plugin.settings.serverRelayUrl)
          .onChange(async (value) => {
            this.plugin.settings.serverRelayUrl = value;
            await this.plugin.saveSettings();
          })
      );

    // 4. Custom Ignore Patterns
    containerEl.createEl('h3', { text: 'Sync Ignore Rules' });

    new Setting(containerEl)
      .setName('Custom Ignored Regex Patterns')
      .setDesc('Enter one regex pattern per line (e.g. ^Private/ or \\.secret$)')
      .addTextArea((text) =>
        text
          .setPlaceholder('^Private/\n\\.secret$')
          .setValue(this.plugin.settings.customIgnoredPatterns.join('\n'))
          .onChange(async (value) => {
            this.plugin.settings.customIgnoredPatterns = value
              .split('\n')
              .map((s) => s.trim())
              .filter(Boolean);
            await this.plugin.saveSettings();
          })
      );
  }
}
