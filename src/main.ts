import {
	App,
	Modal,
	Notice,
	Platform,
	Plugin,
	Setting,
	normalizePath,
} from 'obsidian';
import {
	DEFAULT_SETTINGS,
	DrivesyncSettings,
	DrivesyncSettingTab,
} from './settings';
import type { TokenData, SyncState } from './types';
import { startAuthFlow } from './auth/oauth';
import { findOrCreateFolder } from './drive/client';
import { SyncCoordinator } from './drive/coordinator';
import { startRemoteChangePoller } from './drive/change-poller';
import { startConfigWatcher } from './config-watcher';
import { startWatcher } from './watcher';
import { DrivesyncStatusView, STATUS_VIEW_TYPE } from './ui/status-view';
import { initLogger, flushAndClose, log } from './utils/logger';
import {
	DEFAULT_DRIVE_FOLDER_NAME,
	OAUTH_SCOPE,
	STARTUP_WATCHER_QUIET_MS,
} from './constants';

declare const __DEV__: boolean;

function promptForAuthCode(app: App): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		const modal = new Modal(app);
		let settled = false;
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
			const value = inputEl?.value.trim();
			if (!value) {
				new Notice('Drivesync: Paste the redirect URL first.');
				return;
			}

			settled = true;
			resolve(value);
			modal.close();
		});

		const cancelBtn = btnContainer.createEl('button', {
			text: 'Cancel',
		});
		cancelBtn.addEventListener('click', () => {
			if (settled) return;
			settled = true;
			reject(new Error('Authentication cancelled'));
			modal.close();
		});

		modal.onClose = () => {
			if (settled) return;
			settled = true;
			reject(new Error('Authentication cancelled'));
		};

		modal.open();
	});
}

export default class ObsidianDriveSync extends Plugin {
	settings!: DrivesyncSettings;
	tokenData: TokenData | null = null;
	syncState: SyncState | null = null;
	authorizationUpgradeRequired = false;
	syncing = false;
	syncCoordinator!: SyncCoordinator;

	private watcherCleanup: (() => void) | null = null;
	private remotePollerCleanup: (() => void) | null = null;
	private statusBarItem: HTMLElement | null = null;
	private autoSyncStartTimer: number | null = null;
	private configWatchIgnoreUntil = 0;
	private saveVersion = 0;
	private savedVersion = 0;
	private saveRunning = false;
	private saveWaiters: Array<{
		version: number;
		resolve: () => void;
		reject: (reason: unknown) => void;
	}> = [];

	async onload(): Promise<void> {
		await this.loadAllData();
		this.syncCoordinator = new SyncCoordinator(this);
		initLogger(this.app.vault, this.getPluginDir());
		if (__DEV__) {
			console.debug('Drivesync in dev mode');
		}

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
			if (this.authorizationUpgradeRequired) {
				new Notice(
					'Drivesync: Google Drive permissions changed. Reconnect Google Drive to continue syncing.',
					10000,
				);
			}

			if (!this.tokenData || !this.syncState) {
				return;
			}
			if (!this.isDriveFolderSelectionCurrent()) return;

			this.autoSyncStartTimer = window.setTimeout(() => {
				this.autoSyncStartTimer = null;
				void this.runFullSync().finally(() => {
					this.startAutoSync();
				});
			}, STARTUP_WATCHER_QUIET_MS);
		});
	}

	onunload(): void {
		if (this.autoSyncStartTimer) {
			window.clearTimeout(this.autoSyncStartTimer);
			this.autoSyncStartTimer = null;
		}
		this.stopAutoSync();
		this.syncCoordinator.stop();
		void flushAndClose();
	}

	async loadAllData(): Promise<void> {
		const data = (await this.loadData()) as Record<string, unknown> | null;
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			(data ?? {}) as Partial<DrivesyncSettings>,
		);
		const storedToken =
			(data?.tokenData as TokenData | null) ?? null;
		this.authorizationUpgradeRequired =
			storedToken !== null && storedToken.scope !== OAUTH_SCOPE;
		this.tokenData = this.authorizationUpgradeRequired
			? null
			: storedToken;
		this.syncState = (data?.syncState as SyncState | null) ?? null;
		if (this.syncState && !this.syncState.rootFolderName) {
			this.syncState.rootFolderName = DEFAULT_DRIVE_FOLDER_NAME;
		}
		this.updateStatusBar();
	}

	saveAllData(): Promise<void> {
		const version = ++this.saveVersion;
		const completion = new Promise<void>((resolve, reject) => {
			this.saveWaiters.push({ version, resolve, reject });
		});
		if (!this.saveRunning) void this.flushDataSaves();
		return completion;
	}

	private async flushDataSaves(): Promise<void> {
		this.saveRunning = true;
		try {
			while (this.savedVersion < this.saveVersion) {
				const targetVersion = this.saveVersion;
				try {
					await this.saveData({
						...this.settings,
						tokenData: this.tokenData,
						syncState: this.syncState,
					});
					this.savedVersion = targetVersion;
					this.resolveSaveWaiters(targetVersion);
				} catch (err) {
					this.savedVersion = targetVersion;
					this.rejectSaveWaiters(targetVersion, err);
				}
			}
		} finally {
			this.saveRunning = false;
			if (this.savedVersion < this.saveVersion) {
				void this.flushDataSaves();
			}
		}
	}

	private resolveSaveWaiters(version: number): void {
		const completed = this.saveWaiters.filter(
			(waiter) => waiter.version <= version,
		);
		this.saveWaiters = this.saveWaiters.filter(
			(waiter) => waiter.version > version,
		);
		for (const waiter of completed) waiter.resolve();
	}

	private rejectSaveWaiters(version: number, reason: unknown): void {
		const failed = this.saveWaiters.filter(
			(waiter) => waiter.version <= version,
		);
		this.saveWaiters = this.saveWaiters.filter(
			(waiter) => waiter.version > version,
		);
		for (const waiter of failed) waiter.reject(reason);
	}

	updateStatusBar(): void {
		if (!this.statusBarItem) return;
		if (this.syncing) {
			this.statusBarItem.setText('Drivesync: Syncing...');
		} else if (this.tokenData && !this.isDriveFolderSelectionCurrent()) {
			this.statusBarItem.setText('Drivesync: Reconnect to apply folder');
		} else if (this.tokenData) {
			this.statusBarItem.setText('Drivesync: Connected');
		} else {
			this.statusBarItem.setText('Drivesync: Not connected');
		}
	}

	suppressConfigWatch(durationMs = 5000): void {
		this.configWatchIgnoreUntil = Math.max(
			this.configWatchIgnoreUntil,
			Date.now() + durationMs,
		);
	}

	isConfigWatchSuppressed(): boolean {
		return Date.now() < this.configWatchIgnoreUntil;
	}

	getPluginDir(): string {
		const dir = normalizePath(
			this.manifest.dir ?? `plugins/${this.manifest.id}`,
		);
		if (dir === this.app.vault.configDir) return dir;
		if (dir.startsWith(`${this.app.vault.configDir}/`)) return dir;
		return normalizePath(`${this.app.vault.configDir}/${dir}`);
	}

	isDriveFolderSelectionCurrent(): boolean {
		return (
			this.syncState !== null &&
			this.syncState.rootFolderName ===
				this.settings.driveFolderName.trim()
		);
	}

	async setDriveFolderName(value: string): Promise<void> {
		const folderName = value.trim();
		if (this.settings.driveFolderName === folderName) return;

		this.settings.driveFolderName = folderName;
		if (!this.isDriveFolderSelectionCurrent()) {
			this.stopAutoSync();
			this.syncCoordinator.clear();
		}
		await this.saveAllData();
		this.updateStatusBar();
	}

	async connectDrive(): Promise<void> {
		if (!this.settings.clientId) {
			new Notice(
				'Drivesync: Please set your Google OAUTH client ID in settings first.',
			);
			return;
		}
		const driveFolderName = this.settings.driveFolderName.trim();
		if (!driveFolderName) {
			new Notice(
				'Drivesync: Enter a Google Drive folder name in settings first.',
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

			const accessToken = tokenData.accessToken;
			const rootFolderId = await findOrCreateFolder(
				accessToken,
				driveFolderName,
			);

			this.tokenData = tokenData;
			if (this.syncState?.rootFolderId !== rootFolderId) {
				this.syncState = {
					files: {},
					rootFolderId,
					rootFolderName: driveFolderName,
					lastSyncTime: 0,
				};
			} else {
				this.syncState.rootFolderName = driveFolderName;
			}
			this.authorizationUpgradeRequired = false;
			this.syncCoordinator.clear();

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
		this.syncCoordinator.clear();
		this.tokenData = null;
		this.authorizationUpgradeRequired = false;
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
		if (!this.isDriveFolderSelectionCurrent()) {
			new Notice(
				'Drivesync: Reconnect Google Drive to apply the selected folder.',
			);
			return;
		}

		this.syncing = true;
		this.updateStatusBar();
		try {
			await this.syncCoordinator.runFullSync();
		} finally {
			this.syncing = false;
			this.updateStatusBar();
		}
	}

	startAutoSync(quietMs = 0): void {
		if (!this.settings.autoSync) return;
		if (!this.tokenData) return;
		if (!this.isDriveFolderSelectionCurrent()) return;
		this.stopAutoSync();
		const fileWatcherCleanup = startWatcher(this, { quietMs });
		const configWatcherCleanup = startConfigWatcher(this, quietMs);
		const remotePollerCleanup = startRemoteChangePoller(this);
		this.watcherCleanup = () => {
			fileWatcherCleanup();
			configWatcherCleanup();
		};
		this.remotePollerCleanup = remotePollerCleanup;
	}

	stopAutoSync(): void {
		if (this.watcherCleanup) {
			this.watcherCleanup();
			this.watcherCleanup = null;
		}
		if (this.remotePollerCleanup) {
			this.remotePollerCleanup();
			this.remotePollerCleanup = null;
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
