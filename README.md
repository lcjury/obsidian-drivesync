# DriveSync

Two-way sync your Obsidian vault with Google Drive.

**This is not real-time sync.** Sync happens in three scenarios:

- **On startup**: when you open Obsidian, the plugin compares local and remote files and reconciles changes.
- **On file change**: when you edit a note, changes are uploaded to Drive after a debounce period (2s by default).
- **Manual**: run "Sync now" from the command palette, ribbon icon, or status view at any time.

Conflicts are resolved automatically: the newest version wins, and the older version is saved as `(conflicted).md`.

## Setup

### 1. Create a Google Cloud project

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Create a new project (or select an existing one)
3. Go to **APIs & Services → Library**
4. Search for **Google Drive API** and enable it

### 2. Create OAuth credentials

1. Go to **APIs & Services → OAuth consent screen**
   - Choose **External** (unless you're in a Google Workspace organization)
   - Fill in the app name, user support email, and developer contact email
   - Add the scope `.../auth/drive.file`
   - Under **Test users**, add your Google account email and click Save
   - You don't need to publish the app — keep it in Testing mode

2. Go to **APIs & Services → Credentials → Create credentials → OAuth client ID**
   - Application type: **Desktop application**
   - Name: anything (e.g. "Obsidian DriveSync")
   - Add a redirect URI: `http://127.0.0.1:8520`

3. Copy the **Client ID** and **Client secret**

### 3. Configure the plugin

1. Open Obsidian → **Settings → Community plugins → DriveSync** (gear icon)
2. Paste your **Client ID** and **Client secret**
3. Leave the redirect port at `8520` (or change it if you used a different one in step 2)
4. Run the command **Connect Google Drive** from the command palette (`Ctrl+P`)
5. Your browser will open — sign in with your Google account and authorize the app
6. The initial sync will run automatically

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
| Auto-sync on file changes | On | Upload changes as you edit |
| Debounce (ms) | `2000` | Wait time after last change before uploading |

## Developing

```bash
npm install
npm run dev       # watch mode
npm run build     # production build
npm run lint      # run ESLint
```

Copy `main.js`, `manifest.json`, and `styles.css` to `<vault>/.obsidian/plugins/obsidian-drivesync/` and reload Obsidian.

## Releasing

1. Bump the version: `npm version patch` (or `minor` / `major`)
2. Run `npm run version` to sync `manifest.json` and `versions.json`
3. Create a GitHub release with `main.js`, `manifest.json`, and `styles.css`
4. The release tag must match the version in `manifest.json` exactly (no `v` prefix)
