class PlanEditor {
  /**
   * @param {HTMLElement} container
   */
  constructor(container) {
    this._container = container;
    this._el = null;
    this._workspaceId = null;
    this._approvedAt = null;
    this._textarea = null;
    this._onApprove = null;
  }

  /**
   * @param {string} workspaceId
   * @param {{ content: string | null, approvedAt: string | null }} planData
   * @param {(result: { approvedAt: string, tasks: Array<{id: string, assignedTo: string, dependsOn: string[]}> }) => void} onApprove
   */
  render(workspaceId, planData, onApprove) {
    this._workspaceId = workspaceId;
    this._approvedAt = planData.approvedAt;
    this._onApprove = onApprove;

    if (this._el) {
      this._el.remove();
    }

    this._el = document.createElement('div');
    this._el.className = 'plan-editor';

    const header = document.createElement('div');
    header.className = 'plan-editor-header';

    const title = document.createElement('span');
    title.className = 'plan-editor-title';
    title.textContent = 'Plan';
    header.appendChild(title);

    const status = document.createElement('span');
    status.className = 'badge';
    if (planData.approvedAt) {
      status.className += ' badge-done';
      status.textContent = 'approved';
    } else if (planData.content) {
      status.className += ' badge-thinking';
      status.textContent = 'draft';
    } else {
      status.className += ' badge-idle';
      status.textContent = 'waiting';
    }
    header.appendChild(status);
    this._el.appendChild(header);

    this._textarea = document.createElement('textarea');
    this._textarea.className = 'plan-editor-textarea';
    this._textarea.value = planData.content || '';
    this._textarea.placeholder = 'The Lead agent will propose a plan here...\n\nYou can also write or edit the plan directly.';
    if (planData.approvedAt) {
      this._textarea.readOnly = true;
    }
    this._el.appendChild(this._textarea);

    const actions = document.createElement('div');
    actions.className = 'plan-editor-actions';

    const saveBtn = document.createElement('button');
    saveBtn.className = 'btn btn-secondary';
    saveBtn.textContent = 'Save';
    saveBtn.disabled = !!planData.approvedAt;
    saveBtn.addEventListener('click', () => this._save());
    actions.appendChild(saveBtn);
    this._saveBtn = saveBtn;

    const approveBtn = document.createElement('button');
    approveBtn.className = 'btn btn-primary';
    approveBtn.textContent = 'Approve';
    approveBtn.disabled = !planData.content || !!planData.approvedAt;
    approveBtn.addEventListener('click', () => this._approve());
    actions.appendChild(approveBtn);
    this._approveBtn = approveBtn;

    this._el.appendChild(actions);

    const errorEl = document.createElement('div');
    errorEl.className = 'plan-editor-error';
    errorEl.style.display = 'none';
    this._el.appendChild(errorEl);
    this._errorEl = errorEl;

    this._container.appendChild(this._el);
  }

  async _save() {
    if (!this._workspaceId || !this._textarea) return;
    this._errorEl.style.display = 'none';
    this._saveBtn.disabled = true;
    this._saveBtn.textContent = 'Saving...';
    try {
      await window.argus.updatePlan(this._workspaceId, this._textarea.value);
      this._saveBtn.textContent = 'Saved';
      this._approveBtn.disabled = !this._textarea.value.trim();
      setTimeout(() => {
        if (this._saveBtn) this._saveBtn.textContent = 'Save';
        if (this._saveBtn) this._saveBtn.disabled = false;
      }, 1500);
    } catch (err) {
      this._errorEl.textContent = err.message || 'Failed to save plan';
      this._errorEl.style.display = 'block';
      this._saveBtn.textContent = 'Save';
      this._saveBtn.disabled = false;
    }
  }

  async _approve() {
    if (!this._workspaceId) return;
    this._errorEl.style.display = 'none';
    this._approveBtn.disabled = true;
    this._approveBtn.textContent = 'Approving...';
    try {
      await this._save();
      const result = await window.argus.approvePlan(this._workspaceId);
      this._approvedAt = result.approvedAt;
      this._textarea.readOnly = true;
      this._saveBtn.disabled = true;
      this._approveBtn.textContent = 'Approved';
      if (this._onApprove) this._onApprove(result);
    } catch (err) {
      this._errorEl.textContent = err.message || 'Failed to approve plan';
      this._errorEl.style.display = 'block';
      this._approveBtn.textContent = 'Approve';
      this._approveBtn.disabled = false;
    }
  }

  updateContent(content) {
    if (!this._textarea || this._approvedAt) return;
    if (document.activeElement !== this._textarea) {
      this._textarea.value = content;
    }
    this._approveBtn.disabled = !content;
  }

  dispose() {
    if (this._el) {
      this._el.remove();
      this._el = null;
    }
  }
}
