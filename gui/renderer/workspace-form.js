/** @typedef {{ name: string, agentRatio: {cli: string, count: number}[], repoPath: string }} CreateParams */

class WorkspaceForm {
  constructor() {
    this._overlay = null;
    this._onSubmit = null;
  }

  /**
   * @param {(params: CreateParams) => Promise<void>} onSubmit
   */
  show(onSubmit) {
    if (this._overlay) return;
    this._onSubmit = onSubmit;

    this._overlay = document.createElement('div');
    this._overlay.className = 'modal-overlay';
    this._overlay.innerHTML = `
      <div class="modal">
        <h2>New Workspace</h2>
        <div class="form-group">
          <label>Name</label>
          <input type="text" id="ws-name" placeholder="my-feature" autofocus>
        </div>
        <div class="form-group">
          <label>Agents</label>
          <input type="text" id="ws-agents" placeholder="1xclaude,2xclaude" value="1xclaude">
        </div>
        <div class="form-group">
          <label>Repository Path</label>
          <input type="text" id="ws-repo" placeholder="C:\\Users\\you\\projects\\repo">
        </div>
        <div class="cli-preview" id="cli-preview">argus init  --agents 1xclaude</div>
        <div class="form-error" id="form-error" style="display:none"></div>
        <div class="modal-actions">
          <button class="btn btn-secondary" id="ws-cancel">Cancel</button>
          <button class="btn btn-primary" id="ws-create">Create</button>
        </div>
      </div>
    `;

    document.body.appendChild(this._overlay);

    const nameInput = this._overlay.querySelector('#ws-name');
    const agentsInput = this._overlay.querySelector('#ws-agents');
    const repoInput = this._overlay.querySelector('#ws-repo');
    const preview = this._overlay.querySelector('#cli-preview');

    const updatePreview = () => {
      const name = nameInput.value || '<name>';
      const agents = agentsInput.value || '<ratio>';
      const repo = repoInput.value ? ` --repo "${repoInput.value}"` : '';
      preview.textContent = `argus init ${name} --agents ${agents}${repo}`;
    };

    nameInput.addEventListener('input', updatePreview);
    agentsInput.addEventListener('input', updatePreview);
    repoInput.addEventListener('input', updatePreview);

    this._overlay.querySelector('#ws-cancel').addEventListener('click', () => this.hide());
    this._overlay.querySelector('#ws-create').addEventListener('click', () => this._submit());

    this._overlay.addEventListener('click', (e) => {
      if (e.target === this._overlay) this.hide();
    });

    nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this._submit();
      if (e.key === 'Escape') this.hide();
    });
  }

  hide() {
    if (this._overlay) {
      this._overlay.remove();
      this._overlay = null;
    }
  }

  async _submit() {
    const nameInput = this._overlay.querySelector('#ws-name');
    const agentsInput = this._overlay.querySelector('#ws-agents');
    const repoInput = this._overlay.querySelector('#ws-repo');
    const errorEl = this._overlay.querySelector('#form-error');

    const name = nameInput.value.trim();
    const agentsRaw = agentsInput.value.trim();
    const repoPath = repoInput.value.trim();

    if (!name) {
      errorEl.textContent = 'Name is required';
      errorEl.style.display = 'block';
      return;
    }

    if (!agentsRaw) {
      errorEl.textContent = 'Agent ratio is required (e.g., 1xclaude)';
      errorEl.style.display = 'block';
      return;
    }

    if (!repoPath) {
      errorEl.textContent = 'Repository path is required';
      errorEl.style.display = 'block';
      return;
    }

    const agentRatio = [];
    for (const part of agentsRaw.split(',')) {
      const match = part.trim().match(/^(\d+)x(\w+)$/);
      if (!match) {
        errorEl.textContent = `Invalid agent format "${part}". Use NxCLI (e.g., 1xclaude)`;
        errorEl.style.display = 'block';
        return;
      }
      agentRatio.push({ cli: match[2], count: parseInt(match[1], 10) });
    }

    errorEl.style.display = 'none';
    const createBtn = this._overlay.querySelector('#ws-create');
    createBtn.disabled = true;
    createBtn.textContent = 'Creating...';

    try {
      await this._onSubmit({ name, agentRatio, repoPath });
      this.hide();
    } catch (err) {
      errorEl.textContent = err.message || 'Failed to create workspace';
      errorEl.style.display = 'block';
      createBtn.disabled = false;
      createBtn.textContent = 'Create';
    }
  }
}
