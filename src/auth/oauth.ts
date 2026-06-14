import http from 'http';
import crypto from 'crypto';
import { requestUrl } from 'obsidian';
import {
	GOOGLE_AUTH_URL,
	GOOGLE_TOKEN_URL,
	OAUTH_SCOPE,
} from '../constants';
import type { TokenData } from '../types';

function generateCodeVerifier(): string {
	return crypto.randomBytes(64).toString('base64url');
}

function generateCodeChallenge(verifier: string): string {
	return crypto
		.createHash('sha256')
		.update(verifier)
		.digest('base64url');
}

function buildAuthUrl(
	clientId: string,
	redirectUri: string,
	codeChallenge: string,
): string {
	const params = new URLSearchParams({
		client_id: clientId,
		redirect_uri: redirectUri,
		response_type: 'code',
		scope: OAUTH_SCOPE,
		code_challenge: codeChallenge,
		code_challenge_method: 'S256',
		access_type: 'offline',
		prompt: 'consent',
	});
	return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

function waitForAuthCode(port: number): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		const server = http.createServer((req, res) => {
			const reqUrl = new URL(
				req.url ?? '/',
				`http://127.0.0.1:${port}`,
			);
			const error = reqUrl.searchParams.get('error');
			const code = reqUrl.searchParams.get('code');

			if (error) {
				res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
				res.end(
					'<html><body><h1>Authentication failed</h1><p>Please close this window and try again.</p></body></html>',
				);
				server.close();
				reject(new Error(`OAuth error: ${error}`));
				return;
			}

			if (code) {
				res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
				res.end(
					'<html><body><h1>Authentication successful</h1><p>You can close this window and return to Obsidian.</p></body></html>',
				);
				server.close();
				resolve(code);
				return;
			}

			res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
			res.end('<html><body><h1>Invalid request</h1></body></html>');
			server.close();
			reject(new Error('No authorization code received'));
		});

		server.on('error', (err: NodeJS.ErrnoException) => {
			reject(
				new Error(
					`Server error: ${err.message}. Port ${port} may be in use.`,
				),
			);
		});

		server.listen(port, '127.0.0.1', () => {
			// Server started, will handle callbacks
		});

		window.setTimeout(() => {
			server.close();
			reject(new Error('Authentication timed out (5 minutes)'));
		}, 5 * 60 * 1000);
	});
}

export async function startAuthFlow(
	clientId: string,
	clientSecret: string,
	port: number,
): Promise<TokenData> {
	const codeVerifier = generateCodeVerifier();
	const codeChallenge = generateCodeChallenge(codeVerifier);
	const redirectUri = `http://127.0.0.1:${port}`;
	const authUrl = buildAuthUrl(clientId, redirectUri, codeChallenge);

	window.open(authUrl, '_blank');

	const code = await waitForAuthCode(port);

	const params: Record<string, string> = {
		client_id: clientId,
		code,
		grant_type: 'authorization_code',
		code_verifier: codeVerifier,
		redirect_uri: redirectUri,
	};

	if (clientSecret) {
		params.client_secret = clientSecret;
	}

	const body = new URLSearchParams(params).toString();

	const response = await requestUrl({
		url: GOOGLE_TOKEN_URL,
		method: 'POST',
		contentType: 'application/x-www-form-urlencoded',
		body,
		throw: false,
	});

	if (response.status !== 200) {
		const errBody = response.text;
		console.error('DriveSync token exchange failed:', response.status, errBody);
		throw new Error(
			`Token exchange failed (${response.status}): ${errBody}`,
		);
	}

	const data = response.json as {
		access_token: string;
		expires_in: number;
		refresh_token?: string;
		token_type: string;
	};

	if (data.refresh_token === undefined) {
		throw new Error(
			'No refresh token returned. Revoke app access at https://myaccount.google.com/permissions and try again.',
		);
	}

	return {
		accessToken: data.access_token,
		refreshToken: data.refresh_token,
		expiresAt: Date.now() + (data.expires_in - 60) * 1000,
	};
}

export async function refreshAccessToken(
	clientId: string,
	clientSecret: string,
	refreshToken: string,
): Promise<{ accessToken: string; expiresAt: number }> {
	const params: Record<string, string> = {
		client_id: clientId,
		refresh_token: refreshToken,
		grant_type: 'refresh_token',
	};

	if (clientSecret) {
		params.client_secret = clientSecret;
	}

	const response = await requestUrl({
		url: GOOGLE_TOKEN_URL,
		method: 'POST',
		contentType: 'application/x-www-form-urlencoded',
		body: new URLSearchParams(params).toString(),
		throw: false,
	});

	if (response.status !== 200) {
		throw new Error(
			`Token refresh failed (${response.status}): ${response.text}`,
		);
	}

	const data = response.json as {
		access_token: string;
		expires_in: number;
		token_type: string;
	};

	return {
		accessToken: data.access_token,
		expiresAt: Date.now() + (data.expires_in - 60) * 1000,
	};
}

export async function getValidAccessToken(
	clientId: string,
	clientSecret: string,
	tokenData: TokenData | null,
): Promise<TokenData | null> {
	if (!tokenData) return null;

	if (Date.now() < tokenData.expiresAt) {
		return tokenData;
	}

	const { accessToken, expiresAt } = await refreshAccessToken(
		clientId,
		clientSecret,
		tokenData.refreshToken,
	);

	return {
		accessToken,
		refreshToken: tokenData.refreshToken,
		expiresAt,
	};
}
