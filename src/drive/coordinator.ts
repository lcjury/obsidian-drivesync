import { Notice } from 'obsidian';
import type ObsidianDriveSync from '../main';
import type {
	LocalFileState,
	SyncResult,
	TrackedFile,
} from '../types';
import { getValidAccessToken } from '../auth/oauth';
import { SYNC_CONCURRENCY } from '../constants';
import {
	reconcileFile,
	type ReconcileInput,
	type RemoteFileState,
} from './sync';
import { log } from '../utils/logger';
import { buildFullSyncSeeds, type FullSyncSeed } from './sync-plan';
import { SyncServiceManager } from './sync-services';

interface IdentityRecord {
	key: string;
	driveId?: string;
	localFile?: LocalFileState;
	pathHint?: string;
	remoteState?: RemoteFileState;
}

function emptyResult(): SyncResult {
	return {
		uploaded: 0,
		downloaded: 0,
		conflicted: 0,
		deleted: 0,
		errors: [],
	};
}

function addResult(target: SyncResult, source: SyncResult): void {
	target.uploaded += source.uploaded;
	target.downloaded += source.downloaded;
	target.conflicted += source.conflicted;
	target.deleted += source.deleted;
	target.errors.push(...source.errors);
}

function findTrackedByPath(
	plugin: ObsidianDriveSync,
	path: string,
): TrackedFile | undefined {
	return plugin.syncState?.files[path];
}

function showSummary(result: SyncResult): void {
	const parts: string[] = [];
	if (result.uploaded > 0) parts.push(`${result.uploaded} uploaded`);
	if (result.downloaded > 0) parts.push(`${result.downloaded} downloaded`);
	if (result.conflicted > 0) parts.push(`${result.conflicted} conflicted`);
	if (result.deleted > 0) parts.push(`${result.deleted} deleted`);

	if (parts.length > 0) {
		new Notice(`Drivesync: ${parts.join(', ')}`);
	} else if (result.errors.length === 0) {
		new Notice('Drivesync: Already up to date');
	}
	if (result.errors.length > 0) {
		console.error('DriveSync errors:', result.errors);
	}
}

export class SyncCoordinator {
	private readonly identities = new Map<string, IdentityRecord>();
	private readonly driveKeys = new Map<string, string>();
	private readonly pathKeys = new Map<string, string>();
	private readonly pending = new Set<string>();
	private readonly active = new Set<string>();
	private readonly idleWaiters = new Set<() => void>();
	private nextKey = 1;
	private running = 0;
	private paused = false;
	private stopped = false;
	private refreshRequested = false;
	private tokenPromise: Promise<string | null> | null = null;
	private fullSyncPromise: Promise<SyncResult> | null = null;
	private fullSyncResult: SyncResult | null = null;
	private readonly services = new SyncServiceManager(this.plugin);

	constructor(private readonly plugin: ObsidianDriveSync) {}

	markPath(path: string): void {
		const tracked = findTrackedByPath(this.plugin, path);
		const identity = this.getIdentity(undefined, tracked?.driveId, path);
		identity.localFile = undefined;
		identity.pathHint = path;
		this.enqueue(identity.key);
	}

	markRename(path: string, oldPath: string): void {
		const tracked =
			findTrackedByPath(this.plugin, oldPath) ??
			findTrackedByPath(this.plugin, path);
		const identity = this.getIdentity(
			undefined,
			tracked?.driveId,
			oldPath,
		);
		identity.localFile = undefined;
		identity.pathHint = path;
		this.pathKeys.set(path, identity.key);
		this.enqueue(identity.key);
	}

	markDeleted(path: string): void {
		const tracked = findTrackedByPath(this.plugin, path);
		const identity = this.getIdentity(undefined, tracked?.driveId, path);
		identity.localFile = undefined;
		identity.pathHint = path;
		this.enqueue(identity.key);
	}

	clear(): void {
		this.pending.clear();
		this.refreshRequested = false;
		this.identities.clear();
		this.driveKeys.clear();
		this.pathKeys.clear();
		this.services.clearRemoteCache();
		this.resolveIdleIfNeeded();
	}

	stop(): void {
		this.stopped = true;
		this.clear();
	}

	runFullSync(): Promise<SyncResult> {
		if (this.fullSyncPromise) return this.fullSyncPromise;

		this.fullSyncPromise = this.executeFullSync().finally(() => {
			this.fullSyncPromise = null;
			this.fullSyncResult = null;
			this.maybeScheduleRefresh();
		});
		return this.fullSyncPromise;
	}

	private getIdentity(
		localFile: LocalFileState | undefined,
		driveId: string | undefined,
		pathHint?: string,
	): IdentityRecord {
		let key = localFile
			? this.pathKeys.get(localFile.path)
			: pathHint
				? this.pathKeys.get(pathHint)
				: undefined;
		key ??= driveId ? this.driveKeys.get(driveId) : undefined;

		if (!key) {
			key = `file:${this.nextKey++}`;
			this.identities.set(key, { key });
		}

		const identity = this.identities.get(key)!;
		if (localFile) {
			identity.localFile = localFile;
			this.pathKeys.set(localFile.path, key);
		}
		if (pathHint) this.pathKeys.set(pathHint, key);
		if (driveId) {
			identity.driveId = driveId;
			this.driveKeys.set(driveId, key);
		}
		return identity;
	}

	private enqueue(key: string): void {
		if (this.stopped) return;
		this.pending.add(key);
		this.pump();
	}

	private pump(): void {
		if (this.paused || this.stopped) return;

		while (this.running < SYNC_CONCURRENCY) {
			const key = [...this.pending].find(
				(candidate) => !this.active.has(candidate),
			);
			if (!key) break;

			this.pending.delete(key);
			this.active.add(key);
			this.running++;
			void this.process(key);
		}
		this.resolveIdleIfNeeded();
	}

	private async process(key: string): Promise<void> {
		const identity = this.identities.get(key);
		if (!identity) {
			this.finish(key);
			return;
		}

		const input: ReconcileInput = {
			driveId: identity.driveId,
			localFile: identity.localFile,
			pathHint: identity.pathHint,
			remoteState: identity.remoteState,
		};
		identity.remoteState = undefined;

		try {
			const accessToken = await this.getAccessToken();
			if (!accessToken || !this.plugin.syncState) return;

			const outcome = await reconcileFile(
				this.plugin,
				accessToken,
				input,
				this.services.forAccessToken(accessToken),
			);
			if (outcome.driveId) {
				identity.driveId = outcome.driveId;
				this.driveKeys.set(outcome.driveId, key);
			}
			if (outcome.localFile) {
				identity.localFile = outcome.localFile;
				identity.pathHint = outcome.localFile.path;
				this.pathKeys.set(outcome.localFile.path, key);
			}
			if (outcome.needsFullSync) {
				this.refreshRequested = true;
			}
			if (this.fullSyncResult) {
				addResult(this.fullSyncResult, outcome);
			} else if (outcome.errors.length > 0) {
				console.error('DriveSync errors:', outcome.errors);
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			if (this.fullSyncResult) {
				this.fullSyncResult.errors.push(message);
			} else {
				console.error('DriveSync coordinator error:', err);
			}
		} finally {
			this.finish(key);
		}
	}

	private finish(key: string): void {
		this.active.delete(key);
		this.running--;
		this.pump();
		this.maybeScheduleRefresh();
	}

	private waitForIdle(): Promise<void> {
		if (this.running === 0 && this.pending.size === 0) {
			return Promise.resolve();
		}
		return new Promise((resolve) => {
			this.idleWaiters.add(resolve);
		});
	}

	private resolveIdleIfNeeded(): void {
		if (this.running !== 0 || this.pending.size !== 0) return;
		for (const resolve of this.idleWaiters) resolve();
		this.idleWaiters.clear();
	}

	private async getAccessToken(): Promise<string | null> {
		if (this.tokenPromise) return this.tokenPromise;
		this.tokenPromise = (async () => {
			const previousToken = this.plugin.tokenData;
			const tokenData = await getValidAccessToken(
				this.plugin.settings.clientId,
				this.plugin.settings.clientSecret,
				previousToken,
			);
			if (!tokenData) return null;
			this.plugin.tokenData = tokenData;
			if (tokenData !== previousToken) {
				await this.plugin.saveAllData();
			}
			return tokenData.accessToken;
		})().finally(() => {
			this.tokenPromise = null;
		});
		return this.tokenPromise;
	}

	private async executeFullSync(): Promise<SyncResult> {
		const result = emptyResult();
		this.fullSyncResult = result;
		log('── Sync started ──');

		await this.waitForIdle();
		if (this.stopped) return result;
		this.paused = true;

		try {
			const accessToken = await this.getAccessToken();
			if (!accessToken) {
				result.errors.push(
					'Not authenticated. Run "Connect Google Drive" first.',
				);
				return result;
			}
			if (!this.plugin.syncState) {
				result.errors.push(
					'No sync state. Run "Connect Google Drive" first.',
				);
				return result;
			}
			if (!this.plugin.isDriveFolderSelectionCurrent()) {
				result.errors.push(
					'Drive folder selection changed. Reconnect Google Drive first.',
				);
				return result;
			}

			this.services.clearRemoteCache();
			const seeds = await buildFullSyncSeeds(
				this.plugin,
				accessToken,
			);
			for (const seed of seeds) this.seed(seed);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			result.errors.push(`Sync failed: ${message}`);
			new Notice(`Drivesync: Sync failed — ${message}`);
		} finally {
			this.paused = false;
			this.pump();
		}

		await this.waitForIdle();
		if (this.plugin.syncState) {
			this.plugin.syncState.lastSyncTime = Date.now();
			await this.plugin.saveAllData();
		}
		showSummary(result);

		const sum = [
			result.uploaded > 0 ? `${result.uploaded} up` : '',
			result.downloaded > 0 ? `${result.downloaded} down` : '',
			result.conflicted > 0 ? `${result.conflicted} conflict` : '',
			result.deleted > 0 ? `${result.deleted} deleted` : '',
		]
			.filter(Boolean)
			.join(', ');
		log(`── Sync done${sum ? `: ${sum}` : ', up to date'} ──`);
		return result;
	}

	private seed(seed: FullSyncSeed): void {
		const identity = this.getIdentity(
			seed.localFile,
			seed.driveId,
			seed.pathHint,
		);
		identity.pathHint = seed.pathHint;
		identity.remoteState = seed.remoteState;
		this.pending.add(identity.key);
	}

	private maybeScheduleRefresh(): void {
		if (
			!this.refreshRequested ||
			this.running !== 0 ||
			this.pending.size !== 0 ||
			this.fullSyncPromise ||
			this.stopped
		) {
			return;
		}

		this.refreshRequested = false;
		window.setTimeout(() => {
			if (!this.stopped && this.plugin.tokenData) {
				void this.plugin.runFullSync();
			}
		}, 0);
	}
}
