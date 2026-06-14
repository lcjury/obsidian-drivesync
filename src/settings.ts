import { App, PluginSettingTab, Setting, Notice } from 'obsidian';
import type ObsidianDriveSync from './main';
import { DEFAULT_REDIRECT_PORT, DEFAULT_DEBOUNCE_MS } from './constants';

export interface DrivesyncSettings {
	clientId: string;
	clientSecret: string;
	redirectPort: number;
	debounceMs: number;
	autoSync: boolean;
}

export const DEFAULT_SETTINGS: DrivesyncSettings = {
	clientId: '',
	clientSecret: '',
	redirectPort: DEFAULT_REDIRECT_PORT,
	debounceMs: DEFAULT_DEBOUNCE_MS,
	autoSync: true,
};

export class DrivesyncSettingTab extends PluginSettingTab {
	plugin: ObsidianDriveSync;

	constructor(app: App, plugin: ObsidianDriveSync) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl).setName('Authentication').setHeading();

		new Setting(containerEl)
			.setName('Google OAUTH client ID')
			.setDesc(
				'Create a Google Cloud project, enable the Drive API, and create an OAuth 2.0 Client ID (Desktop application type).',
			)
			.addText((text) =>
				text
					.setPlaceholder(
						'123456789-xxxxx.apps.googleusercontent.com',
					)
					.setValue(this.plugin.settings.clientId)
					.onChange(async (value) => {
						this.plugin.settings.clientId = value.trim();
						await this.plugin.saveAllData();
					}),
			);

		new Setting(containerEl)
			.setName('Google OAUTH client secret')
			.setDesc(
				'The client secret from your Google Cloud OAuth 2.0 credentials.',
			)
			.addText((text) =>
				text
					.setPlaceholder('Gocspx-xxxxxxxxxxxxxxxxxxxx')
					.setValue(this.plugin.settings.clientSecret)
					.onChange(async (value) => {
						this.plugin.settings.clientSecret = value.trim();
						await this.plugin.saveAllData();
					}),
			);

		new Setting(containerEl)
			.setName('Redirect port')
			.setDesc(
				'Local port for OAuth callback. Add http://127.0.0.1:{port} as an authorized redirect URI in Google Cloud Console.',
			)
			.addText((text) =>
				text
					.setPlaceholder(String(DEFAULT_REDIRECT_PORT))
					.setValue(String(this.plugin.settings.redirectPort))
					.onChange(async (value) => {
						const port = parseInt(value, 10);
						if (!isNaN(port) && port > 0 && port <= 65535) {
							this.plugin.settings.redirectPort = port;
							await this.plugin.saveAllData();
						}
					}),
			);

		new Setting(containerEl).setName('Sync').setHeading();

		new Setting(containerEl)
			.setName('Auto-sync on file changes')
			.setDesc(
				'Automatically upload changes when you edit files in the vault.',
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.autoSync)
					.onChange(async (value) => {
						this.plugin.settings.autoSync = value;
						await this.plugin.saveAllData();
						if (value) {
							this.plugin.startAutoSync();
						} else {
							this.plugin.stopAutoSync();
						}
					}),
			);

		new Setting(containerEl)
			.setName('Debounce (ms)')
			.setDesc(
				'Wait time after last file change before uploading (avoids uploading on every keystroke).',
			)
			.addText((text) =>
				text
					.setPlaceholder(String(DEFAULT_DEBOUNCE_MS))
					.setValue(String(this.plugin.settings.debounceMs))
					.onChange(async (value) => {
						const ms = parseInt(value, 10);
						if (!isNaN(ms) && ms >= 500) {
							this.plugin.settings.debounceMs = ms;
							await this.plugin.saveAllData();
						}
					}),
			);

		new Setting(containerEl).setName('Connection').setHeading();

		const connected = !!this.plugin.tokenData;

		const statusEl = containerEl.createDiv({
			cls: 'drivesync-status',
		});
		statusEl.createEl('p', {
			text: connected
				? `Connected. Last sync: ${
						this.plugin.syncState?.lastSyncTime
							? new Date(
									this.plugin.syncState.lastSyncTime,
								).toLocaleString()
							: 'Never'
					}`
				: 'Not connected.',
		});

		if (connected) {
			new Setting(containerEl)
				.setName('Disconnect')
				.setDesc(
					'Remove Google Drive connection from this device.',
				)
				.addButton((btn) =>
					btn
						.setButtonText('Disconnect')
						.setDestructive()
						.onClick(async () => {
							this.plugin.tokenData = null;
							this.plugin.syncState = null;
							this.plugin.stopAutoSync();
							await this.plugin.saveAllData();
							new Notice(
								'Drivesync: Disconnected from Google Drive',
							);
							this.update();
						}),
				);
		} else {
			new Setting(containerEl)
				.setName('Connect Google Drive')
				.setDesc(
					'Authenticate and start syncing your vault with Google Drive.',
				)
				.addButton((btn) =>
					btn
						.setButtonText('Connect')
						.setCta()
						.onClick(async () => {
							await this.plugin.connectDrive();
							this.update();
						}),
				);
		}
	}
}
