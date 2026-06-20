import { ItemView, WorkspaceLeaf } from 'obsidian';
import type ObsidianDriveSync from '../main';

export const STATUS_VIEW_TYPE = 'drivesync-status-view';

export class DrivesyncStatusView extends ItemView {
	plugin: ObsidianDriveSync;

	constructor(leaf: WorkspaceLeaf, plugin: ObsidianDriveSync) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return STATUS_VIEW_TYPE;
	}

	getDisplayText(): string {
		return 'Drivesync status';
	}

	getIcon(): string {
		return 'hard-drive';
	}

	async onOpen(): Promise<void> {
		this.render();
	}

	async onClose(): Promise<void> {
		this.contentEl.empty();
	}

	render(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('drivesync-status-view');

		contentEl.createEl('h3', { text: 'Drivesync status' });

		const connected = !!this.plugin.tokenData;
		const syncState = this.plugin.syncState;

		contentEl.createEl('p', {
			text: connected
				? 'Connected to Google Drive'
				: 'Not connected',
			cls: connected ? 'drivesync-connected' : 'drivesync-disconnected',
		});

		if (syncState) {
			contentEl.createEl('p', {
				text: `Drive folder: ${syncState.rootFolderName}`,
			});
			const lastSync = syncState.lastSyncTime
				? new Date(syncState.lastSyncTime).toLocaleString()
				: 'Never';
			contentEl.createEl('p', {
				text: `Last sync: ${lastSync}`,
			});

			const fileCount = Object.keys(syncState.files).length;
			contentEl.createEl('p', {
				text: `Tracked files: ${fileCount}`,
			});
		}

		const btnContainer = contentEl.createDiv();

		const syncBtn = btnContainer.createEl('button', {
			text: 'Sync now',
		});
		syncBtn.addEventListener('click', () => {
			void this.plugin.runFullSync();
		});

		if (!connected) {
			const connectBtn = btnContainer.createEl('button', {
				text: 'Connect Google Drive',
			});
			connectBtn.addEventListener('click', () => {
				void this.plugin.connectDrive();
			});
		}

		if (connected) {
			const disconnectBtn = btnContainer.createEl('button', {
				text: 'Disconnect',
			});
			disconnectBtn.addEventListener('click', () => {
				void this.plugin.disconnectDrive();
				this.render();
			});
		}
	}
}
