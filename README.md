# DriveSync

Two-way sync your Obsidian vault with Google Drive. DriveSync syncs your vault,
including `.obsidian`, except for a small set of vault-technical files such as
`.obsidian/workspace.json`, `.obsidian/workspace-mobile.json`, and
`.obsidian/graph.json`.

## Why use DriveSync

DriveSync is for vaults that need Google Drive sync without real-time syncing.
It uses your own Google Cloud project and Google account, so you can keep your
vault in storage you already control.

## Features

**This is not real-time sync.** Sync happens in four scenarios:

- **On startup** — when you open Obsidian, the plugin performs a full reconciliation between local and remote files.
- **On file change** — when you edit a note, changes are uploaded to Drive after a debounce period (2s by default).
- **On remote polling** — while auto-sync is enabled, the plugin periodically checks Google Drive for incremental changes and downloads remote updates.
- **Manual** — perform **Sync now** from the command palette, ribbon icon, or status view at any time.

**Conflict resolution**: newest version wins, and the older version is saved as
`(conflicted).md`.

**Use your own GCP account**: A personal GCP account with your own tokens is
enough to keep your Obsidian vault in sync.

## Set up DriveSync

> [!warning]+ Back up your vault
> Before setting up DriveSync, create a backup of your vault. During the first
> sync, DriveSync downloads remote files and may overwrite local files when the
> same file exists both locally and in Google Drive.

### 1. Create a Google Cloud project

1. Open [Google Cloud Console](https://console.cloud.google.com)
2. Create a new project (or select an existing one)
3. Select **APIs & Services → Library**
4. Search for **Google Drive API** and enable it

### 2. Create OAuth credentials

1. Select **APIs & Services → OAuth consent screen**
   - Select **External** (unless you're in a Google Workspace organization)
   - Fill in the app name, user support email, and developer contact email
   - Add the scope `https://www.googleapis.com/auth/drive`
   - Under **Test users**, add your Google account email and select **Save**
   - You don't need to publish the app — keep it in Testing mode

2. Select **APIs & Services → Credentials → Create credentials → OAuth client ID**
   - Application type: **Desktop application**
   - Name: anything (e.g. "Obsidian DriveSync")
   - If Google Cloud asks for an authorized redirect URI, use `http://127.0.0.1:8520`

3. Copy the **Client ID** and **Client secret**

### 3. Configure the plugin

1. Open **Settings → Community plugins → DriveSync**.
2. Paste your **Client ID** and **Client secret**
3. Enter the top-level Google Drive folder to use for this vault
4. Leave the redirect port at `8520` (or change it if you used a different one in step 2)
5. Open the command palette with `Ctrl+P` (Windows/Linux) or `Command+P` (macOS), then perform **Connect Google Drive**
6. Your browser opens. Sign in with your Google account and authorize the app
7. The initial sync will run automatically

DriveSync requests full Google Drive access because it must discover, download,
update, move, and delete files that already exist inside the synchronized
folder. Google limits the narrower `drive.file` scope to files created by the
plugin or explicitly selected through Google Picker.

## Commands

| Command | Description |
|---------|-------------|
| **Sync now** | Run a full two-way sync immediately |
| **Connect Google Drive** | Authenticate with Google Drive |
| **Disconnect Google Drive** | Remove credentials and stop syncing |
| **Show sync status** | Open the status panel in the sidebar |

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| Google OAuth client ID | — | From Google Cloud Console |
| Google OAuth client secret | — | From Google Cloud Console |
| Redirect port | `8520` | Local port for OAuth callback |
| Google Drive folder | `Obsidian Vault` | Top-level Drive folder used for this vault |
| Auto-sync on file changes | On | Upload changes as you edit |
| Debounce (ms) | `2000` | Wait time after last change before uploading |

## Develop DriveSync

```bash
npm install
npm run dev       # watch mode
npm run build     # production build
npm run lint      # run ESLint
```

## Release DriveSync

1. Bump the version: `npm version patch` (or `minor` / `major`)
2. Run `npm run version` to sync `manifest.json` and `versions.json`
3. Create a GitHub release with `main.js`, `manifest.json`, and `styles.css`
4. The release tag must match the version in `manifest.json` exactly (no `v` prefix)
