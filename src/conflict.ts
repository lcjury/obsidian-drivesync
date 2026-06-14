import type { TFile, Vault } from 'obsidian';
import type { TrackedFile } from './types';
import type { DriveFile } from './drive/client';
import { updateFileContent } from './drive/client';

interface ConflictParams {
	path: string;
	localContent: ArrayBuffer;
	remoteContent: ArrayBuffer;
	localMtime: number;
	remoteMtime: number;
	parentDriveId: string;
	tracked: TrackedFile;
	vault: Vault;
	accessToken: string;
}

async function createConflictedCopy(
	basePath: string,
	content: ArrayBuffer,
	vault: Vault,
): Promise<string> {
	const extIndex = basePath.lastIndexOf('.');
	const baseName = extIndex > 0 ? basePath.substring(0, extIndex) : basePath;
	const ext = extIndex > 0 ? basePath.substring(extIndex) : '';

	let conflictedPath = `${baseName} (conflicted)${ext}`;
	let counter = 2;

	while (true) {
		const existing = vault.getAbstractFileByPath(conflictedPath);
		if (!existing) break;
		conflictedPath = `${baseName} (conflicted ${counter})${ext}`;
		counter++;
	}

	await vault.createBinary(conflictedPath, content);
	return conflictedPath;
}

export interface ConflictResult {
	winnerPath: string;
	winnerContent: ArrayBuffer;
	loserPath: string;
	loserContent: ArrayBuffer;
}

export async function resolveConflict(
	params: ConflictParams,
): Promise<ConflictResult> {
	const {
		localContent,
		remoteContent,
		localMtime,
		remoteMtime,
	} = params;

	if (localMtime >= remoteMtime || (localMtime === 0 && remoteMtime === 0)) {
		createConflictedCopy(params.path, remoteContent, params.vault).catch(
			console.error,
		);
		return {
			winnerPath: params.path,
			winnerContent: localContent,
			loserPath: params.path,
			loserContent: remoteContent,
		};
	}

	return {
		winnerPath: params.path,
		winnerContent: remoteContent,
		loserPath: params.path,
		loserContent: localContent,
	};
}

export async function applyConflictToLocal(
	path: string,
	content: ArrayBuffer,
	vault: Vault,
): Promise<void> {
	const existing = vault.getAbstractFileByPath(path) as TFile | null;
	if (existing) {
		await vault.modifyBinary(existing, content);
	} else {
		await vault.createBinary(path, content);
	}
}

export async function uploadConflictToDrive(
	accessToken: string,
	driveId: string,
	content: ArrayBuffer,
	mimeType: string,
): Promise<DriveFile> {
	return updateFileContent(accessToken, driveId, content, mimeType);
}
