/**
 * Grid layout manager — creates one xterm.js terminal per pane.
 * Pane state badges update live as pane.event notifications arrive.
 */

class PaneGrid {
  constructor(container) {
    this._container = container;
    /** @type {Map<string, {terminal: Terminal, fitAddon: FitAddon, wrapper: HTMLElement, state: string, role: string}>} */
    this._panes = new Map();
    this._xtermLoaded = false;
    this._Terminal = null;
    this._FitAddon = null;
    this._resizeHandler = () => this._fitAll();
  }

  async loadXterm(nodeModulesPath) {
    if (this._xtermLoaded) return;

    const linkEl = document.createElement('link');
    linkEl.rel = 'stylesheet';
    linkEl.href = `file://${nodeModulesPath}/@xterm/xterm/css/xterm.css`;
    document.head.appendChild(linkEl);

    await this._loadScript(`file://${nodeModulesPath}/@xterm/xterm/lib/xterm.js`);
    await this._loadScript(`file://${nodeModulesPath}/@xterm/addon-fit/lib/addon-fit.js`);

    this._Terminal = window.Terminal;
    this._FitAddon = window.FitAddon;
    this._xtermLoaded = true;
  }

  /**
   * @param {{ paneId: string, role: string, cli: string, lastKnownState: string }[]} panes
   * @param {(paneId: string, text: string) => void} onInput
   */
  render(panes, onInput) {
    this._container.innerHTML = '';
    this._panes.clear();

    const gridContainer = document.createElement('div');
    gridContainer.className = 'grid-container';

    const cols = Math.ceil(Math.sqrt(panes.length));
    const rows = Math.ceil(panes.length / cols);
    gridContainer.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
    gridContainer.style.gridTemplateRows = `repeat(${rows}, 1fr)`;

    for (const pane of panes) {
      const wrapper = document.createElement('div');
      wrapper.className = `pane-wrapper${pane.role === 'lead' ? ' lead' : ''}`;
      wrapper.dataset.paneId = pane.paneId;

      const header = document.createElement('div');
      header.className = 'pane-header';

      const label = document.createElement('span');
      label.className = 'pane-label';
      label.textContent = `${pane.paneId} (${pane.cli})`;

      const badge = document.createElement('span');
      badge.className = `badge badge-${pane.lastKnownState || 'idle'}`;
      badge.textContent = pane.lastKnownState || 'idle';
      badge.dataset.badge = 'true';

      header.appendChild(label);
      header.appendChild(badge);

      const terminalEl = document.createElement('div');
      terminalEl.className = 'pane-terminal';

      wrapper.appendChild(header);
      wrapper.appendChild(terminalEl);
      gridContainer.appendChild(wrapper);

      const terminal = new this._Terminal({
        theme: {
          background: '#1a1b26',
          foreground: '#c0caf5',
          cursor: '#c0caf5',
          cursorAccent: '#1a1b26',
          selectionBackground: '#33467c',
          black: '#15161e',
          red: '#f7768e',
          green: '#9ece6a',
          yellow: '#e0af68',
          blue: '#7aa2f7',
          magenta: '#bb9af7',
          cyan: '#7dcfff',
          white: '#a9b1d6',
          brightBlack: '#414868',
          brightRed: '#f7768e',
          brightGreen: '#9ece6a',
          brightYellow: '#e0af68',
          brightBlue: '#7aa2f7',
          brightMagenta: '#bb9af7',
          brightCyan: '#7dcfff',
          brightWhite: '#c0caf5',
        },
        fontSize: 13,
        fontFamily: "'Cascadia Code', 'Fira Code', 'Consolas', monospace",
        cursorBlink: true,
        scrollback: 5000,
      });

      const fitAddon = new this._FitAddon.FitAddon();
      terminal.loadAddon(fitAddon);
      terminal.open(terminalEl);

      requestAnimationFrame(() => {
        try { fitAddon.fit(); } catch {}
      });

      terminal.onData((data) => {
        onInput(pane.paneId, data);
      });

      this._panes.set(pane.paneId, {
        terminal,
        fitAddon,
        wrapper,
        state: pane.lastKnownState || 'idle',
        role: pane.role,
      });
    }

    this._container.appendChild(gridContainer);

    window.addEventListener('resize', this._resizeHandler);
  }

  handlePaneEvent(paneId, event) {
    const entry = this._panes.get(paneId);
    if (!entry) return;

    switch (event.kind) {
      case 'output': {
        const bytes = typeof event.bytes === 'string'
          ? Uint8Array.from(atob(event.bytes), c => c.charCodeAt(0))
          : event.bytes;
        entry.terminal.write(bytes);
        break;
      }
      case 'state': {
        entry.state = event.state;
        const badge = entry.wrapper.querySelector('[data-badge]');
        if (badge) {
          badge.className = `badge badge-${event.state}`;
          badge.textContent = event.state;
        }
        break;
      }
    }
  }

  _fitAll() {
    for (const [, entry] of this._panes) {
      try { entry.fitAddon.fit(); } catch {}
    }
  }

  dispose() {
    window.removeEventListener('resize', this._resizeHandler);
    for (const [, entry] of this._panes) {
      entry.terminal.dispose();
    }
    this._panes.clear();
  }

  _loadScript(src) {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src;
      script.onload = resolve;
      script.onerror = reject;
      document.head.appendChild(script);
    });
  }
}
