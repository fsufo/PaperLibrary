// ==UserScript==
// @name         GitLab Enhanced Multi-Branch Cherry-Pick
// @namespace    http://tampermonkey.net/
// @version      2.3
// @description  GitHub-style multi-branch cherry-pick for GitLab with search and history.
// @match        *://*/*/-/merge_requests/*
// @match        *://*/*/-/commit/*
// @icon         https://gitlab.com/favicon.ico
// @grant        GM_addStyle
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_openInTab
// @run-at       document-end
// ==/UserScript==

(function() {
    'use strict';

    const CSS = `
        #gecp-panel {
            position: fixed; bottom: 20px; right: 20px; width: 300px;
            background: #0d1117; border: 1px solid #30363d;
            border-radius: 6px; box-shadow: 0 8px 24px rgba(0,0,0,0.5);
            z-index: 9999; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            color: #c9d1d9; display: flex; flex-direction: column;
        }
        .gecp-header {
            padding: 8px 12px; background: #161b22; border-bottom: 1px solid #30363d;
            display: flex; justify-content: space-between; align-items: center;
        }
        .gecp-header h3 { margin: 0; font-size: 14px; font-weight: 600; }
        .gecp-body { padding: 12px; display: flex; flex-direction: column; gap: 10px; }
        .gecp-input {
            width: 100%; background: #0d1117; border: 1px solid #30363d;
            border-radius: 6px; padding: 6px 10px; color: #c9d1d9; font-size: 13px;
            box-sizing: border-box;
        }
        .gecp-list {
            max-height: 150px; overflow-y: auto; border: 1px solid #30363d;
            border-radius: 6px; background: #0d1117;
        }
        .gecp-item {
            padding: 6px 10px; font-size: 12px; cursor: pointer; display: flex;
            justify-content: space-between; align-items: center; border-bottom: 1px solid #30363d;
        }
        .gecp-item:hover { background: #161b22; }
        .gecp-tag {
            display: inline-flex; align-items: center; background: #21262d;
            border: 1px solid #30363d; border-radius: 2em;
            padding: 0 8px; margin: 2px; font-size: 11px;
        }
        .gecp-tag-remove { margin-left: 4px; cursor: pointer; color: #f85149; font-weight: bold; }
        .gecp-footer { padding: 12px; border-top: 1px solid #30363d; }
        .gecp-btn {
            width: 100%; padding: 8px; font-size: 13px; font-weight: 500;
            border-radius: 6px; cursor: pointer; border: none;
            background: #238636; color: white;
        }
        .gecp-btn:disabled { background: #23863680; cursor: not-allowed; }
        .gecp-status { font-size: 11px; color: #2f81f7; margin-top: 8px; text-align: center; }
    `;

    const API = {
        getProjectId() {
            return window.gon?.project_id || document.querySelector('input#project_id')?.value;
        },
        
        getProjectPath() {
            const match = window.location.pathname.match(/^\/(.+?)(?:\/-\/|\/-\/merge_requests|$)/);
            return match ? decodeURIComponent(match[1]) : null;
        },
        
        async fetchBranches(query = '') {
            const pid = this.getProjectId();
            if (!pid) return [];
            try {
                const resp = await fetch(`/api/v4/projects/${encodeURIComponent(pid)}/repository/branches?search=${encodeURIComponent(query)}&per_page=20`);
                const data = await resp.json();
                return Array.isArray(data) ? data : [];
            } catch (e) { return []; }
        },
        
        async createCherryPickBranch(sha, targetBranch) {
            const pid = this.getProjectId();
            if (!pid) throw new Error('Project ID not found');
            
            const shortSha = sha.substring(0, 8);
            const timestamp = Date.now().toString(36);
            const branchName = `cherry-pick-${shortSha}-${timestamp}`;
            
            const resp = await fetch(`/api/v4/projects/${encodeURIComponent(pid)}/repository/branches`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRF-Token': document.querySelector('meta[name="csrf-token"]')?.content || ''
                },
                body: JSON.stringify({ branch: branchName, ref: targetBranch })
            });
            
            if (!resp.ok) {
                const error = await resp.json();
                throw new Error(error.message || 'Failed to create branch');
            }
            
            const cherryResp = await fetch(`/api/v4/projects/${encodeURIComponent(pid)}/repository/commits/${sha}/cherry_pick`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRF-Token': document.querySelector('meta[name="csrf-token"]')?.content || ''
                },
                body: JSON.stringify({ branch: branchName })
            });
            
            if (!cherryResp.ok) {
                const error = await cherryResp.json();
                throw new Error(error.message || 'Failed to cherry-pick');
            }
            
            return branchName;
        }
    };

    const Storage = {
        getSelectedKey() {
            const projectPath = API.getProjectPath();
            return projectPath ? `gecp_selected_${projectPath}` : 'gecp_selected';
        },
        
        getHistoryKey() {
            const projectPath = API.getProjectPath();
            return projectPath ? `gecp_history_${projectPath}` : 'gecp_history';
        },
        
        getSelectedBranches() {
            return GM_getValue(this.getSelectedKey(), []);
        },
        
        saveSelectedBranches(branches) {
            GM_setValue(this.getSelectedKey(), branches);
        },
        
        getHistory() {
            return GM_getValue(this.getHistoryKey(), []);
        },
        
        addHistory(branch) {
            let history = this.getHistory();
            history = [branch, ...history.filter(b => b !== branch)].slice(0, 10);
            GM_setValue(this.getHistoryKey(), history);
        }
    };

    class UIManager {
        constructor() {
            this.selectedBranches = new Set();
            this.manualSha = null;
            this.init();
        }

        init() {
            GM_addStyle(CSS);
            this.render();
            this.loadSelectedBranches();
        }

        getSHA() {
            const pathParts = window.location.pathname.split('/');
            const commitIdx = pathParts.indexOf('commit');
            if (commitIdx !== -1 && pathParts[commitIdx + 1]) return pathParts[commitIdx + 1];

            const descText = document.querySelector('.description textarea, #merge_request_description')?.value || 
                             document.querySelector('.description .md')?.innerText || '';
            
            const fullMatch = descText.match(/cherry\s+picked\s+from\s+commit\s+([a-fA-F0-9]{40})/i);
            if (fullMatch) return fullMatch[1];

            const urlParams = new URLSearchParams(window.location.search);
            const branchMatch = (urlParams.get('merge_request[source_branch]') || '').match(/cherry-pick-([a-fA-F0-9]{7,40})/);
            if (branchMatch) return branchMatch[1];

            return urlParams.get('cherry_pick_commit_id') || urlParams.get('sha') || 
                   document.querySelector('.commit-sha-group .label, [data-commit-sha]')?.innerText?.trim();
        }

        render() {
            const panel = document.createElement('div');
            panel.id = 'gecp-panel';
            panel.innerHTML = `
                <div class="gecp-header">
                    <h3>🌸 Batch Cherry-Pick</h3>
                    <span id="gecp-close" style="cursor:pointer">×</span>
                </div>
                <div class="gecp-body">
                    <input type="text" class="gecp-input" id="gecp-search" placeholder="Search branches...">
                    <div id="gecp-history-section">
                        <div style="font-size:11px; color:#8b949e; margin-bottom:4px;">Recently Used</div>
                        <div id="gecp-history-list" class="gecp-list" style="max-height:80px"></div>
                    </div>
                    <div class="gecp-list" id="gecp-search-results" style="display:none"></div>
                    <div id="gecp-selected-container" style="min-height: 30px; border: 1px dashed #30363d; border-radius: 6px; padding: 4px;"></div>
                </div>
                <div class="gecp-footer">
                    <div id="gecp-status" class="gecp-status" style="display:none"></div>
                    <button class="gecp-btn" id="gecp-submit" disabled>🚀 Cherry-Pick</button>
                </div>
            `;
            document.body.appendChild(panel);

            this.panel = panel;
            this.searchInput = panel.querySelector('#gecp-search');
            this.historyList = panel.querySelector('#gecp-history-list');
            this.resultsList = panel.querySelector('#gecp-search-results');
            this.selectedContainer = panel.querySelector('#gecp-selected-container');
            this.submitBtn = panel.querySelector('#gecp-submit');
            this.statusEl = panel.querySelector('#gecp-status');

            this.searchInput.addEventListener('input', e => this.handleSearch(e.target.value));
            this.submitBtn.addEventListener('click', () => this.submit());
            panel.querySelector('#gecp-close').addEventListener('click', () => panel.style.display = 'none');
            
            this.loadHistory();
        }

        async handleSearch(val) {
            const historySection = this.panel.querySelector('#gecp-history-section');
            if (!val) {
                this.resultsList.style.display = 'none';
                historySection.style.display = 'block';
                return;
            }
            this.resultsList.style.display = 'block';
            historySection.style.display = 'none';
            this.resultsList.innerHTML = '<div style="padding:8px; font-size:12px; color:#8b949e;">Searching...</div>';
            
            if (this.searchTimeout) clearTimeout(this.searchTimeout);
            this.searchTimeout = setTimeout(async () => {
                const branches = await API.fetchBranches(val);
                this.renderList(this.resultsList, branches.map(b => b.name));
            }, 300);
        }

        renderList(container, branches) {
            container.innerHTML = branches.map(b => `<div class="gecp-item" data-branch="${b}"><span>${b}</span><span>+</span></div>`).join('');
            container.querySelectorAll('.gecp-item').forEach(el => {
                el.onclick = () => this.toggleBranch(el.dataset.branch);
            });
        }

        toggleBranch(branch) {
            if (this.selectedBranches.has(branch)) {
                this.selectedBranches.delete(branch);
            } else {
                this.selectedBranches.add(branch);
                Storage.addHistory(branch);
            }
            this.updateSelectedUI();
            this.saveSelectedBranches();
            this.loadHistory();
        }
        
        loadHistory() {
            this.renderList(this.historyList, Storage.getHistory());
        }
        
        loadSelectedBranches() {
            const saved = Storage.getSelectedBranches();
            saved.forEach(branch => this.selectedBranches.add(branch));
            this.updateSelectedUI();
        }
        
        saveSelectedBranches() {
            Storage.saveSelectedBranches(Array.from(this.selectedBranches));
        }

        updateSelectedUI() {
            this.submitBtn.disabled = this.selectedBranches.size === 0;
            this.selectedContainer.innerHTML = Array.from(this.selectedBranches).map(b => `
                <span class="gecp-tag">${b}<span class="gecp-tag-remove" data-branch="${b}">×</span></span>
            `).join('') || '<div style="font-size:11px; color:#8b949e; text-align:center;">No branches</div>';
            this.selectedContainer.querySelectorAll('.gecp-tag-remove').forEach(el => {
                el.onclick = () => this.toggleBranch(el.dataset.branch);
            });
        }

        async submit() {
            const sha = this.manualSha || this.getSHA();
            if (!sha) {
                alert('SHA not found!');
                return;
            }

            const baseUrl = window.location.href.split('/-/')[0];
            this.statusEl.style.display = 'block';

            const branches = Array.from(this.selectedBranches);
            const projectId = API.getProjectId();
            
            for (let i = 0; i < branches.length; i++) {
                const branch = branches[i];
                this.statusEl.innerText = `🚀 Processing ${i+1}/${branches.length}: ${branch}...`;
                
                try {
                    const cherryPickBranch = await API.createCherryPickBranch(sha, branch);
                    const mrUrl = `${baseUrl}/-/merge_requests/new?merge_request[source_branch]=${encodeURIComponent(cherryPickBranch)}&merge_request[target_branch]=${encodeURIComponent(branch)}&merge_request[source_project_id]=${projectId}&merge_request[target_project_id]=${projectId}`;
                    GM_openInTab(mrUrl, { active: i === 0, insert: true });
                    this.statusEl.innerText = `✅ ${i+1}/${branches.length}: ${branch} done`;
                } catch (e) {
                    console.error(`Failed to cherry-pick to ${branch}:`, e);
                    this.statusEl.innerText = `❌ ${i+1}/${branches.length}: ${branch} failed`;
                    alert(`Failed to cherry-pick to ${branch}: ${e.message}`);
                }
                
                await new Promise(r => setTimeout(r, 1500));
            }
            
            this.statusEl.innerText = '✅ All done!';
            setTimeout(() => this.statusEl.style.display = 'none', 3000);
        }
    }

    if (window.location.pathname.includes('/merge_requests/') || window.location.pathname.includes('/commit/')) {
        new UIManager();
    }
})();
