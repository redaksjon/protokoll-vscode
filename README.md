# Protokoll VS Code Extension

A VS Code extension for viewing Protokoll transcripts and entities via the HTTP MCP server.

**[📖 View Full Documentation](https://redaksjon.github.io/protokoll-vscode/)**

## Features

- **View Transcripts**: Browse and view transcripts from your Protokoll server
- **Transcript Details**: View full transcript content with metadata in a formatted view
- **Filter & Sort**: Filter by project or status, sort by date, title, or duration
- **Chat View**: Browse conversation transcripts separately
- **Quick Actions**: Rename, move to project, copy URL, and more via context menus
- **Server Configuration**: Easy configuration of the Protokoll HTTP MCP server URL

## Requirements

- VS Code 1.90.0 or higher
- Node.js 24.0.0 or higher
- A running Protokoll HTTP MCP server (default: `http://127.0.0.1:3001`)

## Installation

### For Users

Download the latest `.vsix` file from the [GitHub Releases](https://github.com/redaksjon/protokoll-vscode/releases) page.

**Install via VS Code UI:**
1. Open VS Code
2. Press `Cmd+Shift+P` (Mac) or `Ctrl+Shift+P` (Windows/Linux)
3. Type "Extensions: Install from VSIX..."
4. Select the downloaded `protokoll-vscode-*.vsix` file

**Install via Command Line:**
```bash
code --install-extension protokoll-vscode-0.1.1-dev.0.vsix
```

### For Developers

1. Clone this repository
2. Run `npm install`
3. Press `F5` to open a new VS Code window with the extension loaded

## Usage

### First Time Setup

1. When you first activate the extension, you'll be prompted to configure the server URL
2. Enter the URL of your Protokoll HTTP MCP server (e.g., `http://127.0.0.1:3000`)
3. The extension will connect to the server and load available transcripts

### Viewing Transcripts

1. Open the **Protokoll** sidebar (book icon in the activity bar)
2. Click on **Protokoll Transcripts** to see the list of available transcripts
3. Click on any transcript to view its details in a new editor tab

### Configuring Server URL

- Use the command palette (`Cmd+Shift+P` / `Ctrl+Shift+P`) and run **Protokoll: Configure Server URL**
- Or update the setting `protokoll.serverUrl` in your VS Code settings

## Configuration

The extension supports the following settings:

- `protokoll.serverUrl`: URL of the Protokoll HTTP MCP server (default: `http://127.0.0.1:3001`)
- `protokoll.transcriptsDirectory`: Default directory path for transcripts (optional)

## Development

```bash
# Install dependencies
npm install

# Compile TypeScript
npm run compile

# Watch for changes
npm run watch

# Lint
npm run lint
```

## Building & Publishing

### Building the Extension

```bash
# Install dependencies
npm install

# Build (lint + compile)
npm run build

# Watch for changes during development
npm run watch
```

### Packaging for Distribution

```bash
# Package into .vsix file
npm run package

# Or build + package in one step
npm run publish
```

This will create a `protokoll-vscode-<version>.vsix` file in the project root.

### Publishing a Release

The extension is distributed via GitHub Releases. To publish a new version:

1. **Update version** in `package.json`
2. **Build and package**:
   ```bash
   npm run publish
   ```
3. **Create a git tag**:
   ```bash
   git tag v0.1.1
   git push origin v0.1.1
   ```
4. **Create a GitHub Release** and attach the `.vsix` file

### Using kodrdriv

If you're using the `kodrdriv` workflow:

```bash
# From the workspace root
kodrdriv tree publish --sendit

# Or for just this package
cd protokoll-vscode
kodrdriv publish --sendit
```

The `npm run publish` script will automatically run during the kodrdriv publish process.

## License

Apache-2.0
