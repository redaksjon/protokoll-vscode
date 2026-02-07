# VS Code Extension Distribution Guide

This document explains how the Protokoll VS Code extension is packaged and distributed.

## Distribution Method

The extension is distributed via **GitHub Releases** as a `.vsix` file. Users download and install the file manually rather than through the VS Code Marketplace.

## Why Manual Distribution?

- **Simpler workflow**: No publisher account or marketplace approval needed
- **Faster releases**: Push directly to GitHub without marketplace delays
- **Full control**: Manage versioning and releases on your own terms
- **Early access**: Share pre-release versions easily

## Package Scripts

The following npm scripts are available:

```bash
# Build the extension (lint + compile)
npm run build

# Package into .vsix file
npm run package

# Build + package in one step
npm run publish

# Build documentation website
npm run docs:build

# Preview documentation locally
npm run docs:dev
```

## Publishing Workflow

### 1. Manual Release

```bash
# 1. Update version in package.json
npm version patch  # or minor, major

# 2. Build and package
npm run publish

# 3. Create git tag
git tag v0.1.1
git push origin v0.1.1

# 4. Create GitHub Release
# - Go to https://github.com/redaksjon/protokoll-vscode/releases
# - Create new release
# - Attach the .vsix file
```

### 2. Using kodrdriv

The extension integrates with the `kodrdriv` workflow:

```bash
# From workspace root (publishes all packages)
kodrdriv tree publish --sendit

# Or just this package
cd protokoll-vscode
kodrdriv publish --sendit
```

The `npm run publish` script will automatically run during the kodrdriv publish process, creating the `.vsix` file that can be attached to the GitHub Release.

## Installation for Users

Users have two installation options:

### Via VS Code UI

1. Download the `.vsix` file from [GitHub Releases](https://github.com/redaksjon/protokoll-vscode/releases)
2. Open VS Code
3. Press `Cmd+Shift+P` (Mac) or `Ctrl+Shift+P` (Windows/Linux)
4. Type "Extensions: Install from VSIX..."
5. Select the downloaded `.vsix` file

### Via Command Line

```bash
code --install-extension protokoll-vscode-0.1.1-dev.0.vsix
```

## Package Optimization

The `.vscodeignore` file excludes unnecessary files from the package:

- Source TypeScript files (only compiled JS is included)
- Test files and coverage reports
- Documentation website source
- Development files (.github, .cursor, etc.)
- Output and temporary files

This keeps the package size small (~800 KB instead of 19 MB).

## Documentation Website

The documentation website is built separately and deployed to GitHub Pages:

```bash
# Build docs
npm run docs:build

# Preview locally
npm run docs:dev
```

The website is automatically deployed via GitHub Actions when changes are pushed to the `main` or `working` branch.

## File Structure

```
protokoll-vscode/
├── src/                    # TypeScript source (excluded from .vsix)
├── out/                    # Compiled JavaScript (included in .vsix)
├── docs/                   # Documentation website (excluded from .vsix)
├── tests/                  # Test files (excluded from .vsix)
├── node_modules/           # Dependencies (production only in .vsix)
├── package.json            # Package configuration
├── .vscodeignore          # Files to exclude from .vsix
└── *.vsix                 # Packaged extension (excluded from git)
```

## Future: Marketplace Publishing

If you decide to publish to the VS Code Marketplace in the future:

1. Create a publisher account at https://marketplace.visualstudio.com/manage
2. Add `"publisher": "your-publisher-id"` to package.json
3. Get a Personal Access Token (PAT) from Azure DevOps
4. Run `vsce publish` instead of `vsce package`

The current setup is compatible with marketplace publishing - you just need to add the publisher field and authentication.

## Troubleshooting

### Package too large

Check `.vscodeignore` to ensure unnecessary files are excluded. Run `vsce ls --tree` to see what's included.

### TypeScript errors

Run `npm run build` to catch errors before packaging. The `publish` script runs build automatically.

### Missing dependencies

The package includes production dependencies from `node_modules`. If users report missing modules, check that they're in `dependencies` (not `devDependencies`) in package.json.

## Resources

- [VS Code Extension Publishing](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)
- [vsce CLI Documentation](https://github.com/microsoft/vscode-vsce)
- [Extension Manifest Reference](https://code.visualstudio.com/api/references/extension-manifest)
