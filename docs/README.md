# Protokoll VS Code Extension Documentation Website

This directory contains the documentation website for the Protokoll VS Code Extension, built with React and Vite.

## Development

```bash
# Install dependencies
npm install

# Start development server
npm run dev

# Build for production
npm run build

# Preview production build
npm run preview
```

## Deployment

The documentation is automatically deployed to GitHub Pages when changes are pushed to the `main` or `working` branch.

The workflow is defined in `.github/workflows/deploy-docs.yml`.

## Structure

- `src/App.jsx` - Main application component with all content
- `src/index.css` - Styling (based on main Protokoll docs theme)
- `src/main.jsx` - React entry point
- `index.html` - HTML template
- `vite.config.js` - Vite configuration
- `package.json` - Dependencies and scripts

## Live Site

Once deployed, the documentation will be available at:
https://redaksjon.github.io/protokoll-vscode/

## Theme

The site uses a VS Code-inspired color scheme with the same modern design language as the main Protokoll documentation.
