const MERGE_PHASES = ['tagging', 'merging', 'resolving', 'testing', 'complete', 'reverted'];
const DISPLAY_PHASES = ['tagging', 'merging', 'testing', 'complete'];

class MergePane {
  /**
   * @param {HTMLElement} container
   */
  constructor(container) {
    this._container = container;
    this._el = null;
    this._workspaceId = null;
    this._phase = null;
    this._detail = null;
    this._error = null;
    this._cancelBtn = null;
    this._phaseEls = {};
    this._detailEl = null;
  }

  /**
   * @param {string} workspaceId
   * @param {{ phase: string, error?: string, detail?: string } | null} mergeState
   */
  render(workspaceId, mergeState) {
    this._workspaceId = workspaceId;
    this._phase = mergeState?.phase || null;
    this._error = mergeState?.error || null;

    if (this._el) {
      this._el.remove();
    }

    this._el = document.createElement('div');
    this._el.className = 'merge-pane';

    const header = document.createElement('div');
    header.className = 'merge-pane-header';

    const title = document.createElement('span');
    title.className = 'merge-pane-title';
    title.textContent = 'Merge';
    header.appendChild(title);

    const headerRight = document.createElement('div');
    headerRight.style.display = 'flex';
    headerRight.style.alignItems = 'center';
    headerRight.style.gap = '8px';

    const statusBadge = document.createElement('span');
    statusBadge.className = 'badge';
    this._statusBadge = statusBadge;
    headerRight.appendChild(statusBadge);

    this._cancelBtn = document.createElement('button');
    this._cancelBtn.className = 'btn btn-secondary merge-pane-cancel';
    this._cancelBtn.textContent = 'Cancel';
    this._cancelBtn.addEventListener('click', () => this._cancel());
    headerRight.appendChild(this._cancelBtn);

    header.appendChild(headerRight);
    this._el.appendChild(header);

    const pipeline = document.createElement('div');
    pipeline.className = 'merge-pane-pipeline';

    this._phaseEls = {};

    for (let i = 0; i < DISPLAY_PHASES.length; i++) {
      const phase = DISPLAY_PHASES[i];
      const step = document.createElement('div');
      step.className = 'merge-phase-step';

      const indicator = document.createElement('div');
      indicator.className = 'merge-phase-indicator';
      step.appendChild(indicator);

      const label = document.createElement('span');
      label.className = 'merge-phase-label';
      label.textContent = phase;
      step.appendChild(label);

      this._phaseEls[phase] = { step, indicator, label };
      pipeline.appendChild(step);

      if (i < DISPLAY_PHASES.length - 1) {
        const connector = document.createElement('div');
        connector.className = 'merge-phase-connector';
        pipeline.appendChild(connector);
      }
    }

    this._el.appendChild(pipeline);

    this._detailEl = document.createElement('div');
    this._detailEl.className = 'merge-pane-detail';
    this._el.appendChild(this._detailEl);

    this._updateDisplay();
    this._container.appendChild(this._el);
  }

  _updateDisplay() {
    if (!this._el) return;

    const phase = this._phase;
    const isTerminal = phase === 'complete' || phase === 'reverted';
    const isActive = phase && !isTerminal;

    this._cancelBtn.disabled = !isActive;
    this._cancelBtn.style.display = isTerminal ? 'none' : '';

    const phaseIndex = MERGE_PHASES.indexOf(phase);

    for (const dp of DISPLAY_PHASES) {
      const els = this._phaseEls[dp];
      if (!els) continue;

      const dpIndex = MERGE_PHASES.indexOf(dp);
      els.step.classList.remove('past', 'active', 'failed');

      if (phase === 'reverted') {
        els.step.classList.add('failed');
      } else if (phase === 'resolving' && dp === 'merging') {
        els.step.classList.add('active');
      } else if (dp === phase) {
        els.step.classList.add('active');
      } else if (dpIndex < phaseIndex) {
        els.step.classList.add('past');
      }
    }

    if (phase === 'reverted') {
      this._statusBadge.className = 'badge badge-dead';
      this._statusBadge.textContent = 'reverted';
    } else if (phase === 'complete') {
      this._statusBadge.className = 'badge badge-done';
      this._statusBadge.textContent = 'complete';
    } else if (phase === 'resolving') {
      this._statusBadge.className = 'badge badge-waitingPerm';
      this._statusBadge.textContent = 'resolving';
    } else if (phase) {
      this._statusBadge.className = 'badge badge-thinking';
      this._statusBadge.textContent = phase;
    } else {
      this._statusBadge.className = 'badge badge-idle';
      this._statusBadge.textContent = 'idle';
    }

    if (this._error) {
      this._detailEl.textContent = this._error;
      this._detailEl.style.display = 'block';
      this._detailEl.style.color = 'var(--red)';
    } else if (this._detail) {
      this._detailEl.textContent = this._detail;
      this._detailEl.style.display = 'block';
      this._detailEl.style.color = 'var(--text-muted)';
    } else {
      this._detailEl.style.display = 'none';
    }
  }

  /**
   * @param {string} phase
   * @param {string} [detail]
   */
  updatePhase(phase, detail) {
    this._phase = phase;
    if (detail !== undefined) this._detail = detail;
    if (phase === 'reverted' && detail) this._error = detail;
    this._updateDisplay();
  }

  /**
   * @param {string} error
   */
  setError(error) {
    this._error = error;
    this._updateDisplay();
  }

  async _cancel() {
    if (!this._workspaceId) return;
    this._cancelBtn.disabled = true;
    this._cancelBtn.textContent = 'Cancelling...';
    try {
      await window.argus.cancelMerge(this._workspaceId);
    } catch (err) {
      this._cancelBtn.disabled = false;
      this._cancelBtn.textContent = 'Cancel';
    }
  }

  dispose() {
    if (this._el) {
      this._el.remove();
      this._el = null;
    }
  }
}
