import type ObsidianDriveSync from '../main';
import type {
	LocalFileState,
	SyncResult,
	TrackedFile,
} from '../types';
import {
	downloadFile,
	type DriveFile,
	getFileMetadata,
	renameFile,
	trashFile,
	updateFileContent,
	uploadFile,
} from './client';
import { getMimeType } from '../constants';
import { applyConflictToLocal, resolveConflict } from '../conflict';
import { log } from '../utils/logger';
import {
	getLocalFile,
	readLocalFile,
	writeLocalFile,
} from '../local-files';
import { isConfigPath } from '../path-policy';

export interface RemoteFileState {
	file: DriveFile | null;
	path?: string;
}

export interface ReconcileInput {
	driveId?: string;
	localFile?: LocalFileState;
	pathHint?: string;
	remoteState?: RemoteFileState;
}

export interface ReconcileServices {
	resolveRemoteParent(folderPath: string): Promise<string>;
	ensureLocalParent(filePath: string): Promise<void>;
}

export interface ReconcileOutcome extends SyncResult {
	driveId?: string;
	localFile?: LocalFileState;
	needsFullSync?: boolean;
}

function emptyResult(): ReconcileOutcome {
	return {
		uploaded: 0,
		downloaded: 0,
		conflicted: 0,
		deleted: 0,
		errors: [],
	};
}

function formatError(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function remoteMtime(file: DriveFile): number {
	const value = new Date(file.modifiedTime).getTime();
	return Number.isFinite(value) ? value : 0;
}

function trackedFrom(
	path: string,
	driveFile: DriveFile,
	localMtime: number,
): TrackedFile {
	return {
		path,
		driveId: driveFile.id,
		remoteMd5: driveFile.md5Checksum ?? null,
		remoteMtime: remoteMtime(driveFile),
		remoteParentId: driveFile.parents?.[0] ?? null,
		localMtime,
	};
}

function sameTrackedFile(
	left: TrackedFile | undefined,
	right: TrackedFile,
): boolean {
	return (
		left?.path === right.path &&
		left.driveId === right.driveId &&
		left.remoteMd5 === right.remoteMd5 &&
		left.remoteMtime === right.remoteMtime &&
		left.remoteParentId === right.remoteParentId &&
		left.localMtime === right.localMtime
	);
}

function findTracked(
	plugin: ObsidianDriveSync,
	driveId: string | undefined,
	...paths: Array<string | undefined>
): TrackedFile | null {
	const files = plugin.syncState?.files;
	if (!files) return null;

	for (const path of paths) {
		if (!path) continue;
		const tracked = files[path];
		if (tracked && (!driveId || tracked.driveId === driveId)) {
			return tracked;
		}
	}

	if (!driveId) return null;
	return (
		Object.values(files).find((tracked) => tracked.driveId === driveId) ??
		null
	);
}

async function getCurrentLocalFile(
	plugin: ObsidianDriveSync,
	input: ReconcileInput,
	tracked: TrackedFile | null,
	remotePath: string | undefined,
): Promise<LocalFileState | null> {
	const candidates = [
		input.localFile?.path,
		input.pathHint,
		tracked?.path,
		remotePath,
	];
	for (const path of candidates) {
		if (!path) continue;
		const current = await getLocalFile(
			plugin.app.vault.adapter,
			path,
			plugin.app.vault.configDir,
		);
		if (current) return current;
	}

	return null;
}

async function commitTracked(
	plugin: ObsidianDriveSync,
	previousDriveId: string | undefined,
	next: TrackedFile | null,
): Promise<void> {
	const state = plugin.syncState;
	if (!state) return;

	const existing = Object.entries(state.files).filter(
		([, tracked]) =>
			(previousDriveId && tracked.driveId === previousDriveId) ||
			(next && tracked.driveId === next.driveId),
	);
	if (
		next &&
		existing.length === 1 &&
		existing[0]![0] === next.path &&
		sameTrackedFile(existing[0]![1], next)
	) {
		return;
	}
	if (!next && existing.length === 0) return;

	let changed = false;
	for (const [path, tracked] of Object.entries(state.files)) {
		if (
			(previousDriveId && tracked.driveId === previousDriveId) ||
			(next && tracked.driveId === next.driveId && path !== next.path)
		) {
			delete state.files[path];
			changed = true;
		}
	}

	if (next && !sameTrackedFile(state.files[next.path], next)) {
		state.files[next.path] = next;
		changed = true;
	}

	if (!changed) return;
	state.lastSyncTime = Date.now();
	await plugin.saveAllData();
}

async function uploadLocalFile(
	plugin: ObsidianDriveSync,
	accessToken: string,
	localFile: LocalFileState,
	services: ReconcileServices,
): Promise<{ driveFile: DriveFile; localMtime: number; path: string }> {
	const path = localFile.path;
	const localMtime = localFile.mtime;
	const content = await readLocalFile(
		plugin.app.vault.adapter,
		localFile,
	);
	const dir = path.includes('/')
		? path.substring(0, path.lastIndexOf('/'))
		: '';
	const parentId = await services.resolveRemoteParent(dir);
	const name = path.split('/').pop() ?? path;
	const driveFile = await uploadFile(
		accessToken,
		parentId,
		path,
		name,
		content,
		getMimeType(path),
	);
	return { driveFile, localMtime, path };
}

async function downloadRemoteFile(
	plugin: ObsidianDriveSync,
	accessToken: string,
	path: string,
	remoteFile: DriveFile,
	services: ReconcileServices,
): Promise<LocalFileState> {
	const content = await downloadFile(accessToken, remoteFile.id);
	await services.ensureLocalParent(path);
	plugin.suppressConfigWatch();
	return writeLocalFile(
		plugin.app.vault.adapter,
		path,
		content,
		remoteMtime(remoteFile),
	);
}

function remoteFileChangedSinceTracked(
	remoteFile: DriveFile,
	tracked: TrackedFile,
): boolean {
	if (remoteFile.trashed) return true;
	if (remoteFile.md5Checksum !== tracked.remoteMd5) return true;
	if (remoteFile.name !== (tracked.path.split('/').pop() ?? tracked.path)) {
		return true;
	}
	if (
		tracked.remoteMtime > 0 &&
		remoteMtime(remoteFile) !== tracked.remoteMtime
	) {
		return true;
	}
	return (
		tracked.remoteParentId !== undefined &&
		(remoteFile.parents?.[0] ?? null) !== tracked.remoteParentId
	);
}

async function resolveRemoteState(
	accessToken: string,
	input: ReconcileInput,
	tracked: TrackedFile | null,
): Promise<RemoteFileState | null> {
	if (input.remoteState) return input.remoteState;
	const driveId = input.driveId ?? tracked?.driveId;
	if (!driveId) {
		return { file: null };
	}

	const file = await getFileMetadata(accessToken, driveId);
	if (tracked && remoteFileChangedSinceTracked(file, tracked)) {
		return null;
	}
	return {
		file,
		path: tracked?.path ?? input.pathHint,
	};
}

async function reconcileTrackedFile(
	plugin: ObsidianDriveSync,
	accessToken: string,
	input: ReconcileInput,
	tracked: TrackedFile,
	remoteState: RemoteFileState,
	services: ReconcileServices,
): Promise<ReconcileOutcome> {
	const result = emptyResult();
	let remoteFile = remoteState.file;
	let remotePath = remoteState.path ?? tracked.path;
	let localFile = await getCurrentLocalFile(
		plugin,
		input,
		tracked,
		remotePath,
	);

	if (remoteFile?.trashed) remoteFile = null;

	if (localFile && remoteFile) {
		const initialLocalMtime = localFile.mtime;
		const localChanged = initialLocalMtime !== tracked.localMtime;
		const remoteChanged =
			remoteFile.md5Checksum !== tracked.remoteMd5;
		const localPathChanged = localFile.path !== tracked.path;
		const remotePathChanged = remotePath !== tracked.path;

		if (
			localPathChanged &&
			remotePathChanged &&
			localFile.path !== remotePath
		) {
			result.errors.push(
				`Both local and remote renamed ${tracked.path}; run sync after choosing the desired path.`,
			);
			return result;
		}

		if (
			remotePathChanged &&
			localFile.path === tracked.path &&
			!(await plugin.app.vault.adapter.exists(remotePath))
		) {
			await services.ensureLocalParent(remotePath);
			plugin.suppressConfigWatch();
			await plugin.app.vault.adapter.rename(
				localFile.path,
				remotePath,
			);
			const renamed = await getLocalFile(
				plugin.app.vault.adapter,
				remotePath,
				plugin.app.vault.configDir,
			);
			if (!renamed) return result;
			localFile = renamed;
			log(`  renamed local ${tracked.path} → ${remotePath}`);
		} else if (localPathChanged && !remotePathChanged) {
			remoteFile = await renameFile(
				accessToken,
				remoteFile.id,
				tracked.path,
				localFile.path,
				plugin.syncState!.rootFolderId,
				(folderPath) =>
					services.resolveRemoteParent(folderPath),
			);
			remotePath = localFile.path;
			log(`  renamed remote ${tracked.path} → ${remotePath}`);
		}

		if (localChanged && remoteChanged) {
			const localContent = await readLocalFile(
				plugin.app.vault.adapter,
				localFile,
			);
			const remoteContent = await downloadFile(
				accessToken,
				remoteFile.id,
			);
			const currentRemoteMtime = remoteMtime(remoteFile);
			const conflict = await resolveConflict({
				path: localFile.path,
				localContent,
				remoteContent,
				localMtime: initialLocalMtime,
				remoteMtime: currentRemoteMtime,
				configDir: plugin.app.vault.configDir,
				adapter: plugin.app.vault.adapter,
			});
			const winnerMtime =
				conflict.winnerContent === localContent
					? initialLocalMtime
					: currentRemoteMtime;
			plugin.suppressConfigWatch();
			await applyConflictToLocal(
				conflict.winnerPath,
				conflict.winnerContent,
				plugin.app.vault.adapter,
				winnerMtime,
			);
			const winner = await getLocalFile(
				plugin.app.vault.adapter,
				conflict.winnerPath,
				plugin.app.vault.configDir,
			);
			if (!winner) return result;
			remoteFile = await updateFileContent(
				accessToken,
				remoteFile.id,
				conflict.winnerContent,
				getMimeType(conflict.winnerPath),
			);
			await commitTracked(
				plugin,
				tracked.driveId,
				trackedFrom(winner.path, remoteFile, winner.mtime),
			);
			result.conflicted++;
			result.driveId = remoteFile.id;
			result.localFile = winner;
			log(
				conflict.conflictedPath
					? `  conflicted ${winner.path} → ${conflict.conflictedPath}`
					: `  resolved conflict ${winner.path}`,
			);
			return result;
		}

		if (localChanged) {
			const path = localFile.path;
			const localMtime = initialLocalMtime;
			const content = await readLocalFile(
				plugin.app.vault.adapter,
				localFile,
			);
			remoteFile = await updateFileContent(
				accessToken,
				remoteFile.id,
				content,
				getMimeType(path),
			);
			await commitTracked(
				plugin,
				tracked.driveId,
				trackedFrom(path, remoteFile, localMtime),
			);
			result.uploaded++;
			log(`  uploaded   ${path}`);
		} else if (remoteChanged) {
			const downloaded = await downloadRemoteFile(
				plugin,
				accessToken,
				remotePath,
				remoteFile,
				services,
			);
			if (downloaded) {
				await commitTracked(
					plugin,
					tracked.driveId,
					trackedFrom(
						downloaded.path,
						remoteFile,
						downloaded.mtime,
					),
				);
				localFile = downloaded;
				result.downloaded++;
				log(`  downloaded ${remotePath}`);
			}
		} else {
			await commitTracked(
				plugin,
				tracked.driveId,
				trackedFrom(
					localFile.path,
					remoteFile,
					initialLocalMtime,
				),
			);
		}

		result.driveId = remoteFile.id;
		result.localFile = localFile;
		return result;
	}

	if (localFile && !remoteFile) {
		if (
			localFile.mtime !== tracked.localMtime ||
			localFile.path !== tracked.path
		) {
			const uploaded = await uploadLocalFile(
				plugin,
				accessToken,
				localFile,
				services,
			);
			await commitTracked(
				plugin,
				tracked.driveId,
				trackedFrom(
					uploaded.path,
					uploaded.driveFile,
					uploaded.localMtime,
				),
			);
			result.uploaded++;
			result.driveId = uploaded.driveFile.id;
			result.localFile = localFile;
			log(`  uploaded   ${uploaded.path}`);
		} else {
			plugin.suppressConfigWatch();
			await plugin.app.vault.adapter.remove(localFile.path);
			await commitTracked(plugin, tracked.driveId, null);
			result.deleted++;
			log(`  deleted    ${tracked.path} (remote)`);
		}
		return result;
	}

	if (!localFile && remoteFile) {
		const remoteChanged =
			remoteFile.md5Checksum !== tracked.remoteMd5 ||
			remotePath !== tracked.path;
		if (remoteChanged) {
			const downloaded = await downloadRemoteFile(
				plugin,
				accessToken,
				remotePath,
				remoteFile,
				services,
			);
			if (downloaded) {
				await commitTracked(
					plugin,
					tracked.driveId,
					trackedFrom(
						downloaded.path,
						remoteFile,
						downloaded.mtime,
					),
				);
				result.downloaded++;
				result.localFile = downloaded;
				log(`  downloaded ${remotePath}`);
			}
		} else {
			await trashFile(accessToken, remoteFile.id);
			await commitTracked(plugin, tracked.driveId, null);
			result.deleted++;
			log(`  deleted    ${tracked.path} (local)`);
		}
		result.driveId = remoteFile.id;
		return result;
	}

	await commitTracked(plugin, tracked.driveId, null);
	return result;
}

async function reconcileUntrackedFile(
	plugin: ObsidianDriveSync,
	accessToken: string,
	input: ReconcileInput,
	remoteState: RemoteFileState,
	services: ReconcileServices,
): Promise<ReconcileOutcome> {
	const result = emptyResult();
	const remoteFile =
		remoteState.file && !remoteState.file.trashed
			? remoteState.file
			: null;
	const remotePath = remoteState.path ?? input.pathHint;
	const localFile = await getCurrentLocalFile(
		plugin,
		input,
		null,
		remotePath,
	);

	if (localFile && remoteFile) {
		if (isConfigPath(localFile.path, plugin.app.vault.configDir)) {
			const downloaded = await downloadRemoteFile(
				plugin,
				accessToken,
				remotePath ?? localFile.path,
				remoteFile,
				services,
			);
			await commitTracked(
				plugin,
				remoteFile.id,
				trackedFrom(
					downloaded.path,
					remoteFile,
					downloaded.mtime,
				),
			);
			result.downloaded++;
			result.driveId = remoteFile.id;
			result.localFile = downloaded;
			log(`  downloaded ${downloaded.path} (remote bootstrap)`);
			return result;
		}

		const localContent = await readLocalFile(
			plugin.app.vault.adapter,
			localFile,
		);
		const remoteContent = await downloadFile(
			accessToken,
			remoteFile.id,
		);
		const currentRemoteMtime = remoteMtime(remoteFile);
		const conflict = await resolveConflict({
			path: localFile.path,
			localContent,
			remoteContent,
			localMtime: localFile.mtime,
			remoteMtime: currentRemoteMtime,
			configDir: plugin.app.vault.configDir,
			adapter: plugin.app.vault.adapter,
		});
		const winnerMtime =
			conflict.winnerContent === localContent
				? localFile.mtime
				: currentRemoteMtime;
		plugin.suppressConfigWatch();
		await applyConflictToLocal(
			conflict.winnerPath,
			conflict.winnerContent,
			plugin.app.vault.adapter,
			winnerMtime,
		);
		const winner = await getLocalFile(
			plugin.app.vault.adapter,
			conflict.winnerPath,
			plugin.app.vault.configDir,
		);
		if (!winner) return result;
		const updated = await updateFileContent(
			accessToken,
			remoteFile.id,
			conflict.winnerContent,
			getMimeType(conflict.winnerPath),
		);
		await commitTracked(
			plugin,
			remoteFile.id,
			trackedFrom(winner.path, updated, winner.mtime),
		);
		result.conflicted++;
		result.driveId = updated.id;
		result.localFile = winner;
		log(`  conflicted ${winner.path} → ${conflict.conflictedPath}`);
		return result;
	}

	if (remoteFile && remotePath) {
		const downloaded = await downloadRemoteFile(
			plugin,
			accessToken,
			remotePath,
			remoteFile,
			services,
		);
		if (downloaded) {
			await commitTracked(
				plugin,
				remoteFile.id,
				trackedFrom(
					downloaded.path,
					remoteFile,
					downloaded.mtime,
				),
			);
			result.downloaded++;
			result.driveId = remoteFile.id;
			result.localFile = downloaded;
			log(`  downloaded ${remotePath}`);
		}
		return result;
	}

	if (localFile) {
		const uploaded = await uploadLocalFile(
			plugin,
			accessToken,
			localFile,
			services,
		);
		await commitTracked(
			plugin,
			undefined,
			trackedFrom(
				uploaded.path,
				uploaded.driveFile,
				uploaded.localMtime,
			),
		);
		result.uploaded++;
		result.driveId = uploaded.driveFile.id;
		result.localFile = localFile;
		log(`  uploaded   ${uploaded.path}`);
	}

	return result;
}

export async function reconcileFile(
	plugin: ObsidianDriveSync,
	accessToken: string,
	input: ReconcileInput,
	services: ReconcileServices,
): Promise<ReconcileOutcome> {
	const result = emptyResult();
	if (!plugin.syncState) return result;

	const tracked = findTracked(
		plugin,
		input.driveId,
		input.pathHint,
		input.localFile?.path,
		input.remoteState?.path,
	);

	let remoteState: RemoteFileState | null;
	try {
		remoteState = await resolveRemoteState(
			accessToken,
			input,
			tracked,
		);
	} catch (err) {
		log(
			`DriveSync: could not verify remote state for ${input.pathHint ?? input.driveId ?? 'file'}: ${formatError(err)}`,
		);
		result.needsFullSync = true;
		return result;
	}

	if (!remoteState) {
		log(
			`DriveSync: remote changed for ${tracked?.path ?? input.pathHint ?? input.driveId}; scheduling full sync`,
		);
		result.needsFullSync = true;
		return result;
	}

	try {
		if (tracked) {
			return await reconcileTrackedFile(
				plugin,
				accessToken,
				input,
				tracked,
				remoteState,
				services,
			);
		}
		return await reconcileUntrackedFile(
			plugin,
			accessToken,
			input,
			remoteState,
			services,
		);
	} catch (err) {
		result.errors.push(
			`Sync ${tracked?.path ?? input.pathHint ?? input.driveId ?? 'file'}: ${formatError(err)}`,
		);
		return result;
	}
}
