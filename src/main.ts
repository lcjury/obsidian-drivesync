import { App, Modal, Notice, Platform, Plugin, Setting } from 'obsidian';
import {
	DEFAULT_SETTINGS,
	DrivesyncSettings,
	DrivesyncSettingTab,
} from './settings';
import type { TokenData, SyncState } from './types';
import { startAuthFlow } from './auth/oauth';
import { findOrCreateFolder } from './drive/client';
import { fullSync } from './drive/sync';
import { startWatcher } from './watcher';
import { DrivesyncStatusView, STATUS_VIEW_TYPE } from './ui/status-view';
import { initLogger, flushAndClose, log } from './utils/logger';
import { STARTUP_WATCHER_QUIET_MS } from './constants';

function promptForAuthCode(app: App): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		const modal = new Modal(app);
		modal.titleEl.setText('Google authentication');

		const content = modal.contentEl.createDiv();
		content.createEl('p', {
			text: 'After authorizing in the browser, copy the full URL from the address bar and paste it below.',
		});
		content.createEl('p', {
			text: 'The URL will contain ?code=...',
			cls: 'drivesync-hint',
		});

		let inputEl: HTMLInputElement;
		new Setting(content)
			.setName('Redirect URL')
			.addText((text) => {
				inputEl = text.inputEl;
				text.setPlaceholder(
					'HTTP://127.0.0.1:8520?code=...',
				);
			});

		const btnContainer = content.createDiv({
			cls: 'drivesync-auth-buttons',
		});

		const submitBtn = btnContainer.createEl('button', {
			text: 'Submit',
			cls: 'mod-cta',
		});
		submitBtn.addEventListener('click', () => {
			modal.close();
			if (inputEl) {
				resolve(inputEl.value);
			} else {
				reject(new Error('No input'));
			}
		});

		const cancelBtn = btnContainer.createEl('button', {
			text: 'Cancel',
		});
		cancelBtn.addEventListener('click', () => {
			modal.close();
			reject(new Error('Authentication cancelled'));
		});

		modal.onClose = () => {
			reject(new Error('Authentication cancelled'));
		};

		modal.open();
	});
}

export default class ObsidianDriveSync extends Plugin {
	settings!: DrivesyncSettings;
	tokenData: TokenData | null = null;
	syncState: SyncState | null = null;
	syncing = false;

	private watcherCleanup: (() => void) | null = null;
	private statusBarItem: HTMLElement | null = null;
	private autoSyncStartTimer: number | null = null;

	async onload(): Promise<void> {
		await this.loadAllData();
		initLogger(this.app.vault, this.app.vault.configDir);

		this.addRibbonIcon('refresh-cw', 'Drivesync: Sync now', () => {
			void this.runFullSync();
		});

		this.addCommand({
			id: 'sync-now',
			name: 'Sync now',
			callback: () => this.runFullSync(),
		});

		this.addCommand({
			id: 'connect',
			name: 'Connect Google Drive',
			callback: () => this.connectDrive(),
		});

		this.addCommand({
			id: 'disconnect',
			name: 'Disconnect Google Drive',
			callback: () => this.disconnectDrive(),
		});

		this.addCommand({
			id: 'show-status',
			name: 'Show sync status',
			callback: () => {
				void this.showStatus();
			},
		});

		this.addSettingTab(new DrivesyncSettingTab(this.app, this));

		this.registerView(
			STATUS_VIEW_TYPE,
			(leaf) => new DrivesyncStatusView(leaf, this),
		);

		this.statusBarItem = this.addStatusBarItem();
		this.statusBarItem.addClass('drivesync-status-bar');
		this.statusBarItem.setAttribute('aria-label', '');
		this.updateStatusBar();

		this.app.workspace.onLayoutReady(() => {
			if (!this.settings.autoSync || !this.tokenData || !this.syncState) {
				return;
			}

			this.autoSyncStartTimer = window.setTimeout(() => {
				this.autoSyncStartTimer = null;
				this.startAutoSync();
			}, STARTUP_WATCHER_QUIET_MS);
		});
	}

	onunload(): void {
		if (this.autoSyncStartTimer) {
			window.clearTimeout(this.autoSyncStartTimer);
			this.autoSyncStartTimer = null;
		}
		this.stopAutoSync();
		void flushAndClose();
	}

	async loadAllData(): Promise<void> {
		const data = (await this.loadData()) as Record<string, unknown> | null;
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			(data ?? {}) as Partial<DrivesyncSettings>,
		);
		this.tokenData = (data?.tokenData as TokenData | null) ?? null;
		this.syncState = (data?.syncState as SyncState | null) ?? null;
		this.updateStatusBar();
	}

	async saveAllData(): Promise<void> {
		await this.saveData({
			...this.settings,
			tokenData: this.tokenData,
			syncState: this.syncState,
		});
	}

	updateStatusBar(): void {
		if (!this.statusBarItem) return;
		if (this.syncing) {
			this.statusBarItem.setText('Drivesync: Syncing...');
		} else if (this.tokenData) {
			this.statusBarItem.setText('Drivesync: Connected');
		} else {
			this.statusBarItem.setText('Drivesync: Not connected');
		}
	}

	async connectDrive(): Promise<void> {
		if (!this.settings.clientId) {
			new Notice(
				'Drivesync: Please set your Google OAUTH client ID in settings first.',
			);
			return;
		}

		new Notice('Drivesync: Opening browser for authentication...');

		try {
			const tokenData = await startAuthFlow(
				this.settings.clientId,
				this.settings.clientSecret,
				this.settings.redirectPort,
				Platform.isMobile
					? () => promptForAuthCode(this.app)
					: undefined,
			);
			this.tokenData = tokenData;

			const accessToken = tokenData.accessToken;
			const rootFolderId = await findOrCreateFolder(
				accessToken,
				'Obsidian Vault',
			);

			this.syncState = {
				files: {},
				rootFolderId,
				lastSyncTime: 0,
			};

			await this.saveAllData();
			this.updateStatusBar();
			log('DriveSync: connected to Google Drive');
			new Notice('Drivesync: Connected. Running initial sync...');

			await this.runFullSync();

			if (this.settings.autoSync) {
				this.startAutoSync();
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			new Notice(`Drivesync: Connection failed — ${msg}`);
			console.error('DriveSync connection error:', err);
		}
	}

	async disconnectDrive(): Promise<void> {
		this.tokenData = null;
		this.syncState = null;
		this.stopAutoSync();
		await this.saveAllData();
		this.updateStatusBar();
		log('DriveSync: disconnected from Google Drive');
		new Notice('Drivesync: Disconnected from Google Drive.');
	}

	async runFullSync(): Promise<void> {
		if (this.syncing) {
			new Notice('Drivesync: Sync already in progress.');
			return;
		}

		this.syncing = true;
		this.updateStatusBar();
		try {
			await fullSync(this);
		} finally {
			this.syncing = false;
			this.updateStatusBar();
		}
	}

	startAutoSync(quietMs = 0): void {
		if (!this.settings.autoSync) return;
		if (!this.tokenData) return;
		this.stopAutoSync();
		this.watcherCleanup = startWatcher(this, { quietMs });
	}

	stopAutoSync(): void {
		if (this.watcherCleanup) {
			this.watcherCleanup();
			this.watcherCleanup = null;
		}
	}

	async showStatus(): Promise<void> {
		const { workspace } = this.app;

		const existing = workspace.getLeavesOfType(STATUS_VIEW_TYPE);
		if (existing.length > 0) {
			void workspace.revealLeaf(existing[0]!);
			return;
		}

		const leaf = workspace.getRightLeaf(false);
		if (!leaf) return;

		await leaf.setViewState({
			type: STATUS_VIEW_TYPE,
			active: true,
		});

		void workspace.revealLeaf(leaf);
	}
}
