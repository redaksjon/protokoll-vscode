import React from 'react'

function App() {
    return (
        <div className="site">
            {/* Hero Section */}
            <header className="hero">
                <div className="hero-glow"></div>
                <div className="hero-content">
                    <div className="badge">VS Code Extension</div>
                    <h1 className="title">Protokoll for VS Code</h1>
                    <p className="tagline">
                        Browse, filter, and manage your Protokoll transcripts directly from your editor.
                        <br />
                        <span className="highlight">Your transcripts, where you work.</span>
                    </p>
                    <div className="hero-actions">
                        <a href="https://github.com/redaksjon/protokoll-vscode/releases" className="btn btn-primary" target="_blank" rel="noopener noreferrer">
                            Download Latest Release
                        </a>
                        <a href="https://github.com/redaksjon/protokoll-vscode" className="btn btn-secondary" target="_blank" rel="noopener noreferrer">
                            View on GitHub
                        </a>
                    </div>
                </div>
            </header>

            {/* Problem Statement */}
            <section className="problem-section">
                <div className="container">
                    <h2 className="section-title">Why a VS Code Extension?</h2>
                    <div className="problem-grid">
                        <div className="problem-card">
                            <div className="problem-icon problem-icon-text">1</div>
                            <h3>Context Switching</h3>
                            <p>Jumping between terminal, file explorer, and editor breaks your flow</p>
                        </div>
                        <div className="problem-card">
                            <div className="problem-icon problem-icon-text">2</div>
                            <h3>Manual Navigation</h3>
                            <p>Finding the right transcript means navigating nested folders</p>
                        </div>
                        <div className="problem-card">
                            <div className="problem-icon problem-icon-text">3</div>
                            <h3>No Overview</h3>
                            <p>Hard to see all transcripts at once or filter by project</p>
                        </div>
                    </div>
                </div>
            </section>

            {/* Features Overview */}
            <section className="features-section">
                <div className="container">
                    <h2 className="section-title">All Your Transcripts, One Sidebar</h2>
                    <p className="section-subtitle">
                        Connect to your Protokoll HTTP MCP server and access everything from VS Code.
                    </p>
                    
                    <div className="features-grid">
                        <div className="feature-card">
                            <div className="feature-icon">📋</div>
                            <h3>Browse Transcripts</h3>
                            <p>View all transcripts in a dedicated sidebar. Click to open, no file navigation needed.</p>
                        </div>
                        <div className="feature-card">
                            <div className="feature-icon">🔍</div>
                            <h3>Filter & Sort</h3>
                            <p>Filter by project or status. Sort by date, title, or duration. Find what you need fast.</p>
                        </div>
                        <div className="feature-card">
                            <div className="feature-icon">💬</div>
                            <h3>Chat View</h3>
                            <p>Browse conversation transcripts separately. Quick access to chat history.</p>
                        </div>
                        <div className="feature-card">
                            <div className="feature-icon">📝</div>
                            <h3>Rich Metadata</h3>
                            <p>See project, duration, tags, and timestamps at a glance. Full context without opening files.</p>
                        </div>
                        <div className="feature-card">
                            <div className="feature-icon">🔄</div>
                            <h3>Live Updates</h3>
                            <p>Refresh button syncs with your Protokoll server. Always up to date.</p>
                        </div>
                        <div className="feature-card">
                            <div className="feature-icon">⚡</div>
                            <h3>Quick Actions</h3>
                            <p>Rename, move to project, copy URL, open to side. Everything you need in context menus.</p>
                        </div>
                    </div>
                </div>
            </section>

            {/* Screenshot Section */}
            <section className="screenshot-section">
                <div className="container">
                    <h2 className="section-title">See It in Action</h2>
                    <div className="screenshot-placeholder">
                        <div className="vscode-mockup">
                            <div className="vscode-titlebar">
                                <div className="vscode-dots">
                                    <span className="dot red"></span>
                                    <span className="dot yellow"></span>
                                    <span className="dot green"></span>
                                </div>
                                <div className="vscode-title">Visual Studio Code</div>
                            </div>
                            <div className="vscode-body">
                                <div className="vscode-sidebar">
                                    <div className="sidebar-header">
                                        <span className="sidebar-icon">📋</span>
                                        <span className="sidebar-title">PROTOKOLL TRANSCRIPTS</span>
                                    </div>
                                    <div className="sidebar-toolbar">
                                        <span className="toolbar-icon">🔄</span>
                                        <span className="toolbar-icon">🔍</span>
                                        <span className="toolbar-icon">📊</span>
                                        <span className="toolbar-icon">➕</span>
                                    </div>
                                    <div className="sidebar-items">
                                        <div className="sidebar-item">
                                            <span className="item-icon">📄</span>
                                            <span className="item-text">Meeting with Client Alpha</span>
                                        </div>
                                        <div className="sidebar-item">
                                            <span className="item-icon">📄</span>
                                            <span className="item-text">Sprint Planning Notes</span>
                                        </div>
                                        <div className="sidebar-item active">
                                            <span className="item-icon">📄</span>
                                            <span className="item-text">Architecture Discussion</span>
                                        </div>
                                        <div className="sidebar-item">
                                            <span className="item-icon">📄</span>
                                            <span className="item-text">Weekly Standup</span>
                                        </div>
                                    </div>
                                </div>
                                <div className="vscode-editor">
                                    <div className="editor-tab">Architecture Discussion.md</div>
                                    <div className="editor-content">
                                        <div className="editor-line"><span className="editor-heading"># Architecture Discussion</span></div>
                                        <div className="editor-line"></div>
                                        <div className="editor-line"><span className="editor-meta">**Project:** Internal Notes</span></div>
                                        <div className="editor-line"><span className="editor-meta">**Duration:** 12m 34s</span></div>
                                        <div className="editor-line"><span className="editor-meta">**Date:** 2026-02-07</span></div>
                                        <div className="editor-line"></div>
                                        <div className="editor-line"><span className="editor-text">Discussion about microservices architecture...</span></div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </section>

            {/* Quick Start */}
            <section className="quickstart-section">
                <div className="container">
                    <h2 className="section-title">Get Started in 4 Steps</h2>
                    
                    <div className="quickstart-steps">
                        <div className="step">
                            <div className="step-number">1</div>
                            <div className="step-content">
                                <h4>Download Extension</h4>
                                <p>Get the latest .vsix file from GitHub Releases</p>
                                <code><a href="https://github.com/redaksjon/protokoll-vscode/releases" target="_blank" rel="noopener noreferrer">Download .vsix</a></code>
                            </div>
                        </div>
                        <div className="step">
                            <div className="step-number">2</div>
                            <div className="step-content">
                                <h4>Install Extension</h4>
                                <p>Install from VSIX file in VS Code</p>
                                <code>Cmd+Shift+P → "Extensions: Install from VSIX..."</code>
                            </div>
                        </div>
                        <div className="step">
                            <div className="step-number">3</div>
                            <div className="step-content">
                                <h4>Start Protokoll Server</h4>
                                <p>Run the Protokoll HTTP MCP server</p>
                                <code>protokoll-mcp-http</code>
                            </div>
                        </div>
                        <div className="step">
                            <div className="step-number">4</div>
                            <div className="step-content">
                                <h4>Configure & Browse</h4>
                                <p>Set server URL and start browsing transcripts</p>
                                <code>Cmd+Shift+P → "Protokoll: Configure Server URL"</code>
                            </div>
                        </div>
                    </div>
                </div>
            </section>

            {/* Commands Section */}
            <section className="commands-section">
                <div className="container">
                    <h2 className="section-title">Available Commands</h2>
                    <p className="section-subtitle">
                        Access all commands via Command Palette (Cmd+Shift+P / Ctrl+Shift+P)
                    </p>
                    
                    <div className="commands-grid">
                        <div className="command-group">
                            <h4>View & Navigation</h4>
                            <div className="command-list">
                                <div className="command-item">
                                    <span className="command-name">Show Transcripts</span>
                                    <span className="command-desc">Open transcripts sidebar</span>
                                </div>
                                <div className="command-item">
                                    <span className="command-name">Refresh</span>
                                    <span className="command-desc">Sync with server</span>
                                </div>
                                <div className="command-item">
                                    <span className="command-name">Navigate Back</span>
                                    <span className="command-desc">Return to list view</span>
                                </div>
                            </div>
                        </div>
                        <div className="command-group">
                            <h4>Filtering & Sorting</h4>
                            <div className="command-list">
                                <div className="command-item">
                                    <span className="command-name">Filter by Project</span>
                                    <span className="command-desc">Show specific project</span>
                                </div>
                                <div className="command-item">
                                    <span className="command-name">Filter by Status</span>
                                    <span className="command-desc">Filter by status</span>
                                </div>
                                <div className="command-item">
                                    <span className="command-name">Sort Transcripts</span>
                                    <span className="command-desc">Change sort order</span>
                                </div>
                            </div>
                        </div>
                        <div className="command-group">
                            <h4>Transcript Actions</h4>
                            <div className="command-list">
                                <div className="command-item">
                                    <span className="command-name">Rename</span>
                                    <span className="command-desc">Change transcript title</span>
                                </div>
                                <div className="command-item">
                                    <span className="command-name">Move to Project</span>
                                    <span className="command-desc">Reassign project</span>
                                </div>
                                <div className="command-item">
                                    <span className="command-name">Copy URL</span>
                                    <span className="command-desc">Copy transcript URL</span>
                                </div>
                            </div>
                        </div>
                        <div className="command-group">
                            <h4>Configuration</h4>
                            <div className="command-list">
                                <div className="command-item">
                                    <span className="command-name">Configure Server URL</span>
                                    <span className="command-desc">Set MCP server URL</span>
                                </div>
                                <div className="command-item">
                                    <span className="command-name">New Transcript</span>
                                    <span className="command-desc">Start new session</span>
                                </div>
                                <div className="command-item">
                                    <span className="command-name">Create Note</span>
                                    <span className="command-desc">Create new note</span>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </section>

            {/* Configuration Section */}
            <section className="config-section">
                <div className="container">
                    <h2 className="section-title">Configuration</h2>
                    <p className="section-subtitle">
                        Configure the extension in VS Code settings (Cmd+, / Ctrl+,)
                    </p>
                    
                    <div className="config-options">
                        <div className="config-option">
                            <div className="config-header">
                                <code className="config-key">protokoll.serverUrl</code>
                                <span className="config-type">string</span>
                            </div>
                            <p className="config-desc">URL of the Protokoll HTTP MCP server</p>
                            <div className="config-default">Default: <code>http://127.0.0.1:3001</code></div>
                        </div>
                        <div className="config-option">
                            <div className="config-header">
                                <code className="config-key">protokoll.transcriptsDirectory</code>
                                <span className="config-type">string</span>
                            </div>
                            <p className="config-desc">Default directory path for transcripts (optional)</p>
                            <div className="config-default">Default: <code>""</code> (will prompt if not set)</div>
                        </div>
                    </div>
                </div>
            </section>

            {/* Requirements Section */}
            <section className="requirements-section">
                <div className="container">
                    <h2 className="section-title">Requirements</h2>
                    <div className="requirements-grid">
                        <div className="requirement-card">
                            <div className="requirement-icon">💻</div>
                            <h3>VS Code 1.90.0+</h3>
                            <p>Recent version of Visual Studio Code</p>
                        </div>
                        <div className="requirement-card">
                            <div className="requirement-icon">🔧</div>
                            <h3>Node.js 24+</h3>
                            <p>Required for running the extension</p>
                        </div>
                        <div className="requirement-card">
                            <div className="requirement-icon">🌐</div>
                            <h3>Protokoll HTTP Server</h3>
                            <p>Running instance of protokoll-mcp-http</p>
                        </div>
                    </div>
                </div>
            </section>

            {/* Keyboard Shortcuts */}
            <section className="shortcuts-section">
                <div className="container">
                    <h2 className="section-title">Keyboard Shortcuts</h2>
                    <div className="shortcuts-grid">
                        <div className="shortcut-item">
                            <div className="shortcut-keys">
                                <kbd>Cmd</kbd> + <kbd>Alt</kbd> + <kbd>P</kbd>
                            </div>
                            <div className="shortcut-desc">Focus Protokoll Transcripts view</div>
                        </div>
                        <div className="shortcut-item">
                            <div className="shortcut-keys">
                                <kbd>←</kbd>
                            </div>
                            <div className="shortcut-desc">Navigate back (when in transcripts view)</div>
                        </div>
                    </div>
                    <p className="shortcuts-note">
                        <strong>Windows/Linux:</strong> Use <kbd>Ctrl</kbd> instead of <kbd>Cmd</kbd>
                    </p>
                </div>
            </section>

            {/* Installation Details */}
            <section className="install-section">
                <div className="container">
                    <h2 className="section-title">Installation Methods</h2>
                    
                    <div className="install-methods">
                        <div className="install-method">
                            <h3>Via VS Code UI</h3>
                            <ol className="install-steps">
                                <li>Download the <code>.vsix</code> file from <a href="https://github.com/redaksjon/protokoll-vscode/releases" target="_blank" rel="noopener noreferrer">GitHub Releases</a></li>
                                <li>Open VS Code</li>
                                <li>Press <kbd>Cmd+Shift+P</kbd> (Mac) or <kbd>Ctrl+Shift+P</kbd> (Windows/Linux)</li>
                                <li>Type "Extensions: Install from VSIX..."</li>
                                <li>Select the downloaded <code>.vsix</code> file</li>
                            </ol>
                        </div>
                        <div className="install-method">
                            <h3>Via Command Line</h3>
                            <div className="code-block">
                                <code>code --install-extension protokoll-vscode-0.1.1-dev.0.vsix</code>
                            </div>
                            <p className="install-note">Replace the version number with the version you downloaded.</p>
                        </div>
                    </div>
                </div>
            </section>

            {/* CTA */}
            <section className="cta-section">
                <div className="container">
                    <h2>Bring Protokoll Into Your Editor</h2>
                    <p>Stop switching contexts. Browse and manage transcripts where you work.</p>
                    <div className="cta-buttons">
                        <a href="https://github.com/redaksjon/protokoll-vscode/releases" className="btn btn-primary btn-large" target="_blank" rel="noopener noreferrer">
                            Download Latest Release
                        </a>
                        <a href="https://github.com/redaksjon/protokoll-vscode" className="btn btn-secondary btn-large" target="_blank" rel="noopener noreferrer">
                            View on GitHub
                        </a>
                    </div>
                </div>
            </section>

            <footer className="footer">
                <div className="container">
                    <p>Apache 2.0 License | Part of the <a href="https://github.com/redaksjon">Redaksjon</a> project</p>
                    <p><a href="https://redaksjon.github.io/protokoll/">Main Protokoll Documentation</a></p>
                </div>
            </footer>
        </div>
    )
}

export default App
