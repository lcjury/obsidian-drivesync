import { TFile } from 'obsidian';
import type ObsidianDriveSync from '../main';
import {
	driveFileToLocalPath,
	listAllFilesRecursive,
	type DriveFile,
} from './client';
import type { RemoteFileState } from './sync';

export interface FullSyncSeed {
	driveId?: string;
	localFile?: TFile;
	pathHint: string;
	remoteState: RemoteFileState;
}

export async function buildFullSyncSeeds(
	plugin: ObsidianDriveSync,
	accessToken: string,
): Promise<FullSyncSeed[]> {
	const state = plugin.syncState!;
	const remoteFiles = await listAllFilesRecursive(
		accessToken,
		state.rootFolderId,
	);
	const folders = remoteFiles.filter(
		(file) =>
			file.mimeType === 'application/vnd.google-apps.folder',
	);
	const remoteById = new Map<string, DriveFile>();
	const remoteByPath = new Map<string, DriveFile>();
	for (const remoteFile of remoteFiles) {
		if (
			remoteFile.mimeType ===
			'application/vnd.google-apps.folder'
		) {
			continue;
		}
		const path = driveFileToLocalPath(remoteFile, folders);
		remoteById.set(remoteFile.id, remoteFile);
		remoteByPath.set(path, remoteFile);
	}

	const configDir = plugin.app.vault.configDir + '/';
	const localByPath = new Map<string, TFile>();
	for (const localFile of plugin.app.vault.getFiles()) {
		if (!localFile.path.startsWith(configDir)) {
			localByPath.set(localFile.path, localFile);
		}
	}

	const seeds: FullSyncSeed[] = [];
	const handledRemote = new Set<string>();
	const handledLocal = new Set<string>();

	for (const tracked of Object.values(state.files)) {
		const remoteFile = remoteById.get(tracked.driveId) ?? null;
		const remotePath = remoteFile
			? driveFileToLocalPath(remoteFile, folders)
			: tracked.path;
		const localFile =
			localByPath.get(remotePath) ??
			localByPath.get(tracked.path);
		if (remoteFile) handledRemote.add(remoteFile.id);
		if (localFile) handledLocal.add(localFile.path);
		seeds.push({
			driveId: tracked.driveId,
			localFile,
			pathHint: localFile?.path ?? tracked.path,
			remoteState: {
				file: remoteFile,
				path: remotePath,
			},
		});
	}

	for (const [path, remoteFile] of remoteByPath) {
		if (handledRemote.has(remoteFile.id)) continue;
		const localFile = localByPath.get(path);
		if (localFile) handledLocal.add(path);
		seeds.push({
			driveId: remoteFile.id,
			localFile,
			pathHint: path,
			remoteState: {
				file: remoteFile,
				path,
			},
		});
	}

	for (const [path, localFile] of localByPath) {
		if (handledLocal.has(path)) continue;
		seeds.push({
			localFile,
			pathHint: path,
			remoteState: {
				file: null,
				path,
			},
		});
	}
	return seeds;
}
