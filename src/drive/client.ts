import { requestUrl } from 'obsidian';
import {
	DRIVE_FILES_URL,
	DRIVE_UPLOAD_BASE,
} from '../constants';

type RequestUrlOptions = Exclude<Parameters<typeof requestUrl>[0], string>;
type RequestUrlResponse = Awaited<ReturnType<typeof requestUrl>>;

export interface DriveFile {
	id: string;
	name: string;
	mimeType: string;
	md5Checksum: string | null;
	modifiedTime: string;
	size: string;
	trashed: boolean;
	parents: string[];
	appProperties?: Record<string, string>;
}

export interface DriveFileListResponse {
	files: DriveFile[];
	nextPageToken?: string;
}

function authHeaders(accessToken: string): Record<string, string> {
	return { Authorization: `Bearer ${accessToken}` };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function getString(
	record: Record<string, unknown>,
	key: string,
): string | null {
	const value = record[key];
	return typeof value === 'string' ? value : null;
}

function describeDriveErrorBody(body: unknown): string | null {
	if (!isRecord(body)) return null;

	const error = body.error;
	if (isRecord(error)) {
		const message = getString(error, 'message');
		const status = getString(error, 'status');
		const errors = error.errors;
		let reason: string | null = null;

		if (Array.isArray(errors) && isRecord(errors[0])) {
			reason = getString(errors[0], 'reason');
		}

		return [
			status ? `status=${status}` : '',
			reason ? `reason=${reason}` : '',
			message ? `message=${message}` : '',
		]
			.filter(Boolean)
			.join(', ');
	}

	if (typeof error === 'string') {
		const description = getString(body, 'error_description');
		return description ? `${error}: ${description}` : error;
	}

	return null;
}

async function requestDriveUrl(
	options: RequestUrlOptions,
): Promise<RequestUrlResponse> {
	const response = await requestUrl({
		...options,
		throw: false,
	});

	if (response.status < 400) {
		return response;
	}

	const detail =
		describeDriveErrorBody(response.json as unknown) ||
		response.text ||
		'No response body';
	throw new Error(
		`Google Drive request failed (${response.status}) ${options.method ?? 'GET'} ${options.url}: ${detail}`,
	);
}

export async function findOrCreateFolder(
	accessToken: string,
	folderName: string,
): Promise<string> {
	const query = encodeURIComponent(
		`name = '${folderName}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
	);
	const listResponse = await requestDriveUrl({
		url: `${DRIVE_FILES_URL}?q=${query}&fields=files(id,name)&pageSize=10`,
		headers: authHeaders(accessToken),
	});
	const data = listResponse.json as DriveFileListResponse;

	if (data.files && data.files.length > 0) {
		return data.files[0]!.id;
	}

	const createResponse = await requestDriveUrl({
		url: DRIVE_FILES_URL,
		method: 'POST',
		headers: {
			...authHeaders(accessToken),
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			name: folderName,
			mimeType: 'application/vnd.google-apps.folder',
		}),
	});
	const folder = createResponse.json as DriveFile;
	return folder.id;
}

export async function findOrCreateFolderPath(
	accessToken: string,
	rootFolderId: string,
	folderPath: string,
): Promise<string> {
	if (!folderPath) return rootFolderId;

	const parts = folderPath.split('/').filter((p) => p.length > 0);
	let currentParentId = rootFolderId;

	for (const part of parts) {
		const query = encodeURIComponent(
			`name = '${part}' and mimeType = 'application/vnd.google-apps.folder' and '${currentParentId}' in parents and trashed = false`,
		);
		const response = await requestDriveUrl({
			url: `${DRIVE_FILES_URL}?q=${query}&fields=files(id,name)&pageSize=1`,
			headers: authHeaders(accessToken),
		});
		const data = response.json as DriveFileListResponse;

		if (data.files && data.files.length > 0) {
			currentParentId = data.files[0]!.id;
		} else {
			const createResponse = await requestDriveUrl({
				url: DRIVE_FILES_URL,
				method: 'POST',
				headers: {
					...authHeaders(accessToken),
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					name: part,
					mimeType: 'application/vnd.google-apps.folder',
					parents: [currentParentId],
				}),
			});
			const folder = createResponse.json as DriveFile;
			currentParentId = folder.id;
		}
	}

	return currentParentId;
}

export async function listFilesInFolder(
	accessToken: string,
	folderId: string,
): Promise<DriveFile[]> {
	const allFiles: DriveFile[] = [];
	let pageToken: string | undefined;

	do {
		const query = encodeURIComponent(
			`'${folderId}' in parents and trashed = false`,
		);
		let url = `${DRIVE_FILES_URL}?q=${query}&fields=files(id,name,md5Checksum,modifiedTime,mimeType,size,trashed,parents,appProperties)&pageSize=1000`;
		if (pageToken) {
			url += `&pageToken=${pageToken}`;
		}

		const response = await requestDriveUrl({
			url,
			headers: authHeaders(accessToken),
		});
		const data = response.json as DriveFileListResponse;
		if (data.files) {
			allFiles.push(...data.files);
		}
		pageToken = data.nextPageToken;
	} while (pageToken);

	return allFiles;
}

export async function listAllFilesRecursive(
	accessToken: string,
	rootFolderId: string,
): Promise<DriveFile[]> {
	const allFiles: DriveFile[] = [];
	const folderQueue: string[] = [rootFolderId];

	while (folderQueue.length > 0) {
		const batch = folderQueue.splice(0, Math.min(folderQueue.length, 10));
		const results = await Promise.all(
			batch.map((fid) => listFilesInFolder(accessToken, fid)),
		);

		for (const files of results) {
			for (const file of files) {
				if (file.mimeType === 'application/vnd.google-apps.folder') {
					allFiles.push(file);
					folderQueue.push(file.id);
				} else {
					allFiles.push(file);
				}
			}
		}
	}

	return allFiles;
}

function resolveFilePath(
	file: DriveFile,
	allFiles: DriveFile[],
): string {
	const parent = file.parents?.[0];
	if (!parent) return file.name;

	const folders = allFiles.filter(
		(f) => f.mimeType === 'application/vnd.google-apps.folder',
	);
	const folderMap = new Map(folders.map((f) => [f.id, f]));

	const pathParts: string[] = [];
	let currentId: string | undefined = parent;

	while (currentId) {
		const folder = folderMap.get(currentId);
		if (!folder) break;
		pathParts.unshift(folder.name);
		currentId = folder.parents?.[0];
	}

	pathParts.push(file.name);
	return pathParts.join('/');
}

export function driveFileToLocalPath(
	file: DriveFile,
	folderFiles: DriveFile[],
): string {
	return resolveFilePath(file, folderFiles);
}

async function createFileMetadata(
	accessToken: string,
	name: string,
	parentId: string,
	mimeType: string,
): Promise<DriveFile> {
	const response = await requestDriveUrl({
		url: DRIVE_FILES_URL,
		method: 'POST',
		headers: {
			...authHeaders(accessToken),
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			name,
			parents: [parentId],
			mimeType,
		}),
	});
	return response.json as DriveFile;
}

async function uploadMediaContent(
	accessToken: string,
	fileId: string,
	content: ArrayBuffer,
	mimeType: string,
): Promise<DriveFile> {
	const response = await requestDriveUrl({
		url: `${DRIVE_UPLOAD_BASE}/files/${fileId}?uploadType=media`,
		method: 'PATCH',
		headers: {
			...authHeaders(accessToken),
			'Content-Type': mimeType,
		},
		body: content,
	});
	return response.json as DriveFile;
}

export async function uploadFile(
	accessToken: string,
	parentId: string,
	_localPath: string,
	name: string,
	content: ArrayBuffer,
	mimeType: string,
): Promise<DriveFile> {
	const fileMeta = await createFileMetadata(
		accessToken,
		name,
		parentId,
		mimeType,
	);
	return uploadMediaContent(accessToken, fileMeta.id, content, mimeType);
}

export async function updateFileContent(
	accessToken: string,
	fileId: string,
	content: ArrayBuffer,
	mimeType: string,
): Promise<DriveFile> {
	return uploadMediaContent(accessToken, fileId, content, mimeType);
}

export async function renameFile(
	accessToken: string,
	fileId: string,
	oldPath: string,
	newPath: string,
	rootFolderId: string,
): Promise<DriveFile> {
	const oldDir = oldPath.includes('/')
		? oldPath.substring(0, oldPath.lastIndexOf('/'))
		: '';
	const newDir = newPath.includes('/')
		? newPath.substring(0, newPath.lastIndexOf('/'))
		: '';
	const newName = newPath.split('/').pop() ?? newPath;

	const dirChanged = oldDir !== newDir;

	const newParentId = dirChanged
		? await findOrCreateFolderPath(accessToken, rootFolderId, newDir)
		: null;

	let url = `${DRIVE_FILES_URL}/${fileId}`;
	const params = new URLSearchParams();
	if (dirChanged) {
		params.set('addParents', newParentId!);
		const file = await getFileMetadata(accessToken, fileId);
		const oldParent = file.parents?.[0];
		if (oldParent) {
			params.set('removeParents', oldParent);
		}
	}
	if (params.toString()) {
		url += `?${params.toString()}`;
	}

	const response = await requestDriveUrl({
		url,
		method: 'PATCH',
		headers: {
			...authHeaders(accessToken),
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			name: newName,
		}),
	});

	return response.json as DriveFile;
}

export async function downloadFile(
	accessToken: string,
	fileId: string,
): Promise<ArrayBuffer> {
	const response = await requestDriveUrl({
		url: `${DRIVE_FILES_URL}/${fileId}?alt=media`,
		headers: authHeaders(accessToken),
	});
	return response.arrayBuffer;
}

export async function trashFile(
	accessToken: string,
	fileId: string,
): Promise<void> {
	await requestDriveUrl({
		url: `${DRIVE_FILES_URL}/${fileId}`,
		method: 'PATCH',
		headers: {
			...authHeaders(accessToken),
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({ trashed: true }),
	});
}

export async function getFileMetadata(
	accessToken: string,
	fileId: string,
): Promise<DriveFile> {
	const response = await requestDriveUrl({
		url: `${DRIVE_FILES_URL}/${fileId}?fields=id,name,md5Checksum,modifiedTime,mimeType,size,trashed,parents,appProperties`,
		headers: authHeaders(accessToken),
	});
	return response.json as DriveFile;
}
