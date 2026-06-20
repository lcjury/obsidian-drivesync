import { TFile } from 'obsidian';
import type ObsidianDriveSync from '../main';
import { log } from '../utils/logger';
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

function isUnsupportedGoogleFile(file: DriveFile): boolean {
	return (
		file.mimeType.startsWith('application/vnd.google-apps.') &&
		file.mimeType !== 'application/vnd.google-apps.folder'
	);
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
	log(`DriveSync: listed ${remoteFiles.length} remote entries`);
	const folders = remoteFiles.filter(
		(file) =>
			file.mimeType === 'application/vnd.google-apps.folder',
	);
	const remoteById = new Map<string, DriveFile>();
	const remoteByPath = new Map<string, DriveFile>();
	const ignoredRemoteIds = new Set<string>();
	const ignoredRemotePaths = new Set<string>();
	let ignoredRemoteFiles = 0;
	for (const remoteFile of remoteFiles) {
		if (
			remoteFile.mimeType ===
			'application/vnd.google-apps.folder'
		) {
			continue;
		}
		const path = driveFileToLocalPath(remoteFile, folders);
		if (isUnsupportedGoogleFile(remoteFile)) {
			ignoredRemoteFiles++;
			ignoredRemoteIds.add(remoteFile.id);
			ignoredRemotePaths.add(path);
			log(
				`DriveSync: ignored remote file ${path} (unsupported MIME type: ${remoteFile.mimeType})`,
			);
			continue;
		}
		remoteById.set(remoteFile.id, remoteFile);
		remoteByPath.set(path, remoteFile);
	}
	if (ignoredRemoteFiles > 0) {
		log(
			`DriveSync: ignored ${ignoredRemoteFiles} unsupported remote file${ignoredRemoteFiles === 1 ? '' : 's'}`,
		);
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
		if (ignoredRemoteIds.has(tracked.driveId)) {
			const localFile = localByPath.get(tracked.path);
			if (localFile) handledLocal.add(localFile.path);
			continue;
		}
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
		if (ignoredRemotePaths.has(path)) continue;
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
