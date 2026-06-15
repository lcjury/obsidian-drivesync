import { requestUrl } from 'obsidian';
import {
	DRIVE_FILES_URL,
	DRIVE_UPLOAD_BASE,
} from '../constants';

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

export async function findOrCreateFolder(
	accessToken: string,
	folderName: string,
): Promise<string> {
	const query = encodeURIComponent(
		`name = '${folderName}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
	);
	const listResponse = await requestUrl({
		url: `${DRIVE_FILES_URL}?q=${query}&fields=files(id,name)&pageSize=10`,
		headers: authHeaders(accessToken),
	});
	const data = listResponse.json as DriveFileListResponse;

	if (data.files && data.files.length > 0) {
		return data.files[0]!.id;
	}

	const createResponse = await requestUrl({
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
		const response = await requestUrl({
			url: `${DRIVE_FILES_URL}?q=${query}&fields=files(id,name)&pageSize=1`,
			headers: authHeaders(accessToken),
		});
		const data = response.json as DriveFileListResponse;

		if (data.files && data.files.length > 0) {
			currentParentId = data.files[0]!.id;
		} else {
			const createResponse = await requestUrl({
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

		const response = await requestUrl({
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
	if (!parent) return file.appProperties?.path ?? file.name;

	const folders = allFiles.filter(
		(f) => f.mimeType === 'application/vnd.google-apps.folder',
	);
	const folderMap = new Map(folders.map((f) => [f.id, f]));

	const pathParts: string[] = [];
	let currentId: string | undefined = parent;

	while (currentId) {
		const folder = folderMap.get(currentId);
		if (!folder) break;
		const folderPath = folder.appProperties?.path;
		if (folderPath) {
			pathParts.unshift(folderPath);
			break;
		}
		pathParts.unshift(folder.name);
		currentId = folder.parents?.[0];
	}

	pathParts.push(file.name);
	return pathParts.length > 1 || !file.appProperties?.path
		? pathParts.join('/')
		: file.appProperties.path;
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
	appProperties: Record<string, string>,
): Promise<DriveFile> {
	const response = await requestUrl({
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
			appProperties,
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
	const response = await requestUrl({
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
	localPath: string,
	name: string,
	content: ArrayBuffer,
	mimeType: string,
): Promise<DriveFile> {
	const fileMeta = await createFileMetadata(accessToken, name, parentId, mimeType, {
		path: localPath,
	});
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

export async function updateFilePath(
	accessToken: string,
	fileId: string,
	localPath: string,
): Promise<void> {
	await requestUrl({
		url: `${DRIVE_FILES_URL}/${fileId}`,
		method: 'PATCH',
		headers: {
			...authHeaders(accessToken),
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			appProperties: { path: localPath },
		}),
	});
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

	const response = await requestUrl({
		url,
		method: 'PATCH',
		headers: {
			...authHeaders(accessToken),
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			name: newName,
			appProperties: { path: newPath },
		}),
	});

	return response.json as DriveFile;
}

export async function downloadFile(
	accessToken: string,
	fileId: string,
): Promise<ArrayBuffer> {
	const response = await requestUrl({
		url: `${DRIVE_FILES_URL}/${fileId}?alt=media`,
		headers: authHeaders(accessToken),
	});
	return response.arrayBuffer;
}

export async function trashFile(
	accessToken: string,
	fileId: string,
): Promise<void> {
	await requestUrl({
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
	const response = await requestUrl({
		url: `${DRIVE_FILES_URL}/${fileId}?fields=id,name,md5Checksum,modifiedTime,mimeType,size,trashed,parents,appProperties`,
		headers: authHeaders(accessToken),
	});
	return response.json as DriveFile;
}
