# GitHub Pages Setup Guide

This guide explains how to enable GitHub Pages for the Protokoll VS Code Extension documentation.

## Prerequisites

- Repository must be public (or you need GitHub Pro/Enterprise for private repo pages)
- You must have admin access to the repository

## Setup Steps

### 1. Enable GitHub Pages

1. Go to your repository on GitHub: `https://github.com/redaksjon/protokoll-vscode`
2. Click on **Settings** (top right)
3. In the left sidebar, click **Pages** (under "Code and automation")
4. Under **Source**, select **GitHub Actions**
   - This allows the workflow to deploy pages automatically
   - If you see "Deploy from a branch" dropdown, click it and select **GitHub Actions**

### 2. Verify Workflow Permissions

1. Still in **Settings**, click **Actions** → **General** in the left sidebar
2. Scroll down to **Workflow permissions**
3. Ensure **Read and write permissions** is selected
4. Check the box for **Allow GitHub Actions to create and approve pull requests**
5. Click **Save**

### 3. Trigger the Deployment

The documentation will be automatically deployed when:
- You push changes to the `main` or `working` branch that affect the `docs/` directory
- You manually trigger the workflow from the Actions tab

To manually trigger:
1. Go to **Actions** tab
2. Click **Deploy Documentation to GitHub Pages** workflow
3. Click **Run workflow** button
4. Select the branch and click **Run workflow**

### 4. Access Your Documentation

Once deployed (usually takes 1-2 minutes), your documentation will be available at:

**https://redaksjon.github.io/protokoll-vscode/**

## Troubleshooting

### Pages Not Deploying

If the workflow runs but pages don't deploy:

1. Check that GitHub Pages is enabled in Settings → Pages
2. Verify the source is set to "GitHub Actions"
3. Check the Actions tab for any error messages
4. Ensure the workflow has proper permissions (see step 2 above)

### 404 Errors on Refresh

The build script automatically creates a `404.html` file that mirrors `index.html` to handle client-side routing. This is already configured in `package.json`:

```json
"build": "vite build && cp dist/index.html dist/404.html"
```

### Base Path Issues

The Vite config is set to use `/protokoll-vscode/` as the base path:

```js
base: '/protokoll-vscode/'
```

If your repository name changes, update this in `docs/vite.config.js`.

## Custom Domain (Optional)

To use a custom domain:

1. In Settings → Pages, enter your custom domain
2. Create a `CNAME` file in `docs/public/` with your domain name
3. Configure DNS with your domain provider:
   - Add a CNAME record pointing to `redaksjon.github.io`
   - Or add A records pointing to GitHub's IPs

## Workflow Details

The deployment workflow (`.github/workflows/deploy-docs.yml`) does the following:

1. **Build Job**:
   - Checks out the code
   - Sets up Node.js 24
   - Installs dependencies from `docs/`
   - Builds the site with `npm run build`
   - Uploads the `dist/` folder as an artifact

2. **Deploy Job**:
   - Deploys the artifact to GitHub Pages
   - Runs after the build job succeeds

## Local Development

To work on the documentation locally:

```bash
cd docs
npm install
npm run dev
```

The site will be available at `http://localhost:5173`

## Making Changes

After making changes to the documentation:

1. Test locally with `npm run dev`
2. Build to verify: `npm run build`
3. Commit and push to `main` or `working` branch
4. The workflow will automatically deploy the changes
5. Check the Actions tab to monitor deployment progress

Changes typically appear within 1-2 minutes after the workflow completes.
