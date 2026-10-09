import { App, PluginSettingTab, Setting, Notice } from 'obsidian';
import type GoogleDriveSyncPlugin from '../main';

export class GoogleDriveSettingTab extends PluginSettingTab {
  plugin: GoogleDriveSyncPlugin;

  constructor(app: App, plugin: GoogleDriveSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h2', { text: 'VaultGlide — Google Drive Sync' });
    containerEl.createEl('p', {
      text: 'Private, direct manual cloud synchronization using your personal Google Drive account. Zero third-party storage.',
      cls: 'setting-item-description',
    });

    const isConnected = Boolean(this.plugin.settings.accessToken);
    const isSessionExpired = this.plugin.settings.lastSyncStatus === 'unauthenticated';

    // ==========================================
    // 1. Connection State Card (Clean 3-State UI)
    // ==========================================
    if (!isConnected) {
      // STATE 1: NOT CONNECTED
      const connectSetting = new Setting(containerEl)
        .setName('Connection Status: Not Connected')
        .setDesc('Connect your personal Google Drive via the VaultGlide web portal to sync your notes across devices.')
        .addButton((btn) =>
          btn
            .setButtonText('Connect with VaultGlide')
            .setCta()
            .onClick(() => {
              const targetUrl = this.plugin.settings.serverRelayUrl || 'http://localhost:5180';
              window.open(targetUrl, '_blank');
              new Notice('Opening VaultGlide Web Portal in your browser...');
            })
        );
      connectSetting.settingEl.style.border = '1px solid var(--background-modifier-border)';
      connectSetting.settingEl.style.borderRadius = '8px';
      connectSetting.settingEl.style.padding = '12px';
      connectSetting.settingEl.style.marginBottom = '16px';
    } else if (isSessionExpired) {
      // STATE 3: SESSION EXPIRED / REAUTHENTICATION NEEDED
      const expiredSetting = new Setting(containerEl)
        .setName('⚠️ Session Expired / Re-authentication Needed')
        .setDesc(`Your Google Drive token for ${this.plugin.settings.userEmail || 'account'} needs to be renewed.`)
        .addButton((btn) =>
          btn
            .setButtonText('Re-authenticate on Web')
            .setWarning()
            .onClick(() => {
              const targetUrl = this.plugin.settings.serverRelayUrl || 'http://localhost:5180';
              window.open(targetUrl, '_blank');
              new Notice('Opening VaultGlide to renew connection...');
            })
        )
        .addButton((btn) =>
          btn.setButtonText('Disconnect').onClick(async () => {
            await this.handleDisconnect();
          })
        );
      expiredSetting.settingEl.style.border = '1px solid var(--text-warning)';
      expiredSetting.settingEl.style.borderRadius = '8px';
      expiredSetting.settingEl.style.padding = '12px';
      expiredSetting.settingEl.style.marginBottom = '16px';
    } else {
      // STATE 2: ACTIVE & CONNECTED
      const connectedSetting = new Setting(containerEl)
        .setName(`🟢 Connected: ${this.plugin.settings.userEmail || 'Google User'}`)
        .setDesc(`Cloud Vault: Google Drive/VaultGlide/${this.plugin.settings.vaultName}`)
        .addButton((btn) =>
          btn
            .setButtonText('Push Notes')
            .setCta()
            .onClick(async () => {
              await this.plugin.syncEngine.push();
            })
        )
        .addButton((btn) =>
          btn.setButtonText('Pull Notes').onClick(async () => {
            await this.plugin.syncEngine.pull();
          })
        )
        .addButton((btn) =>
          btn
            .setButtonText('Disconnect')
            .setWarning()
            .onClick(async () => {
              await this.handleDisconnect();
            })
        );
      connectedSetting.settingEl.style.border = '1px solid var(--interactive-accent)';
      connectedSetting.settingEl.style.borderRadius = '8px';
      connectedSetting.settingEl.style.padding = '12px';
      connectedSetting.settingEl.style.marginBottom = '16px';
    }

    // ==========================================
    // 2. Vault Configuration
    // ==========================================
    containerEl.createEl('h3', { text: 'Vault & Storage Settings' });

    new Setting(containerEl)
      .setName('Cloud Vault Folder Name')
      .setDesc('Folder created inside your personal Google Drive (My Drive/VaultGlide/<VaultName>)')
      .addText((text) =>
        text
          .setPlaceholder('MyVault')
          .setValue(this.plugin.settings.vaultName)
          .onChange(async (value) => {
            this.plugin.settings.vaultName = value.trim() || 'MyVault';
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('VaultGlide Web Portal URL')
      .setDesc('The web companion dashboard URL for web viewing and initial authentication.')
      .addText((text) =>
        text
          .setPlaceholder('http://localhost:5180')
          .setValue(this.plugin.settings.serverRelayUrl)
          .onChange(async (value) => {
            this.plugin.settings.serverRelayUrl = value.trim();
            await this.plugin.saveSettings();
          })
      );

    // ==========================================
    // 3. Configuration & Community Plugins Sync (.obsidian)
    // ==========================================
    containerEl.createEl('h3', { text: 'Configuration & Plugin Sync (.obsidian)' });
    containerEl.createEl('p', {
      text: 'Synchronize Obsidian preferences, themes, and community plugins across your devices via Google Drive.',
      cls: 'setting-item-description',
    });

    new Setting(containerEl)
      .setName('Sync Configuration & Plugins (.obsidian)')
      .setDesc('Master toggle: Scan and synchronize files inside the .obsidian folder.')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.syncConfigDir)
          .onChange(async (val) => {
            this.plugin.settings.syncConfigDir = val;
            await this.plugin.saveSettings();
            this.display();
          })
      );

    if (this.plugin.settings.syncConfigDir) {
      new Setting(containerEl)
        .setName('Sync Core Settings & Hotkeys')
        .setDesc('Sync general app preferences, file options, and hotkeys (app.json, hotkeys.json).')
        .addToggle((toggle) =>
          toggle
            .setValue(this.plugin.settings.syncCoreSettings)
            .onChange(async (val) => {
              this.plugin.settings.syncCoreSettings = val;
              await this.plugin.saveSettings();
            })
        );

      new Setting(containerEl)
        .setName('Sync Themes & CSS Snippets')
        .setDesc('Sync active theme, custom styles, and snippets (appearance.json, snippets/).')
        .addToggle((toggle) =>
          toggle
            .setValue(this.plugin.settings.syncAppearance)
            .onChange(async (val) => {
              this.plugin.settings.syncAppearance = val;
              await this.plugin.saveSettings();
            })
        );

      new Setting(containerEl)
        .setName('Sync Community Plugins')
        .setDesc('Sync installed community plugins and settings. (VaultGlide credentials are automatically excluded for safety).')
        .addToggle((toggle) =>
          toggle
            .setValue(this.plugin.settings.syncCommunityPlugins)
            .onChange(async (val) => {
              this.plugin.settings.syncCommunityPlugins = val;
              await this.plugin.saveSettings();
            })
        );

      new Setting(containerEl)
        .setName('Sync Workspace Layout (Open Tabs)')
        .setDesc('Sync open tabs and panes (workspace.json). Recommended: OFF if syncing between Desktop and Mobile.')
        .addToggle((toggle) =>
          toggle
            .setValue(this.plugin.settings.syncWorkspaceLayout)
            .onChange(async (val) => {
              this.plugin.settings.syncWorkspaceLayout = val;
              await this.plugin.saveSettings();
            })
        );
    }

    // ==========================================
    // 4. Sync Ignore Rules
    // ==========================================
    containerEl.createEl('h3', { text: 'Sync Ignore Rules' });

    new Setting(containerEl)
      .setName('Custom Ignored Regex Patterns')
      .setDesc('Enter one regex pattern per line to exclude files/folders from sync (e.g. ^Private/ or \\.secret$)')
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

  private async handleDisconnect(): Promise<void> {
    this.plugin.settings.accessToken = '';
    this.plugin.settings.refreshToken = '';
    this.plugin.settings.userEmail = '';
    this.plugin.settings.vaultFolderId = '';
    this.plugin.settings.lastSyncStatus = 'unauthenticated';
    await this.plugin.saveSettings();
    this.plugin.statusBar.setStatus('unauthenticated');
    new Notice('Disconnected from Google Drive');
    this.display();
  }
}
