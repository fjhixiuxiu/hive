const fs = require('fs');
const path = require('path');
const os = require('os');
const log = require('./log');

// ── Checklist Templates ─────────────────────────────────

function getChecklistTemplates() {
  return Array.from(this.checklistTemplates.values());
}

function setChecklistTemplate(name, items) {
  if (!name) return null;
  const template = { name, items: Array.isArray(items) ? items : [] };
  this.checklistTemplates.set(name, template);
  this.emit('checklistTemplates:changed', this.getChecklistTemplates());
  this._saveState();
  return template;
}

function removeChecklistTemplate(name) {
  if (!this.checklistTemplates.has(name)) return false;
  this.checklistTemplates.delete(name);
  this.emit('checklistTemplates:changed', this.getChecklistTemplates());
  this._saveState();
  return true;
}

// ── Session Context ─────────────────────────────────────

function getSessionContext(sessionNum) {
  return this.sessionContext.get(Number(sessionNum)) || {};
}

function getAllSessionContexts() {
  const obj = {};
  for (const [num, ctx] of this.sessionContext) obj[num] = ctx;
  return obj;
}

function setSessionContext(sessionNum, updates) {
  const num = Number(sessionNum);
  const existing = this.sessionContext.get(num) || {};
  const merged = { ...existing };
  for (const [k, v] of Object.entries(updates)) {
    if (v === null || v === undefined) {
      delete merged[k];
    } else {
      merged[k] = v;
    }
  }
  // plan and planText are mutually exclusive — last one set wins
  if (updates.plan && updates.plan !== null) delete merged.planText;
  if (updates.planText && updates.planText !== null) delete merged.plan;
  if (Object.keys(merged).length === 0) {
    this.sessionContext.delete(num);
  } else {
    this.sessionContext.set(num, merged);
  }
  this.emit('context:changed', { session: num, context: merged });
  this._saveState();
  return merged;
}

function clearSessionContext(sessionNum) {
  const num = Number(sessionNum);
  this.sessionContext.delete(num);
  this.emit('context:changed', { session: num, context: {} });
  this._saveState();
}

// ── Task Checklist ──────────────────────────────────────

function toggleChecklistItem(taskId, itemId) {
  const task = this.tasks.get(taskId);
  if (!task || !task.checklist) return null;
  const item = task.checklist.find(i => i.id === itemId);
  if (!item) return null;
  item.checked = !item.checked;
  this.emit('task:updated', task);
  this._saveState();
  return task;
}

function addChecklistItem(taskId, text) {
  const task = this.tasks.get(taskId);
  if (!task) return null;
  if (!task.checklist) task.checklist = [];
  const item = {
    id: `cl-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    text,
    checked: false,
  };
  task.checklist.push(item);
  this.emit('task:updated', task);
  this._saveState();
  return task;
}

function removeChecklistItem(taskId, itemId) {
  const task = this.tasks.get(taskId);
  if (!task || !task.checklist) return null;
  const idx = task.checklist.findIndex(i => i.id === itemId);
  if (idx < 0) return null;
  task.checklist.splice(idx, 1);
  this.emit('task:updated', task);
  this._saveState();
  return task;
}

function setTaskChecklist(taskId, checklist) {
  const task = this.tasks.get(taskId);
  if (!task) return null;
  task.checklist = (checklist || []).map(item => ({
    id: item.id || `cl-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    text: item.text,
    checked: !!item.checked,
  }));
  this.emit('task:updated', task);
  this._saveState();
  return task;
}

// ── Designations ────────────────────────────────────────

function setDesignation(num, designation) {
  if (designation) {
    this.designations.set(num, designation);
  } else {
    this.designations.delete(num);
  }
  this._saveState();
  this.emit('designations:changed', this.getDesignations());
  // Re-evaluate dispatch with new designation mapping
  this._tryAutoDispatch().catch(err =>
    log.error('Auto-dispatch error:', err.message));
}

function getDesignations() {
  const obj = {};
  for (const [num, des] of this.designations) obj[num] = des;
  return obj;
}

// ── Designation Definitions ─────────────────────────────

function getDesignationDefs() {
  return Array.from(this.designationDefs.values());
}

function setDesignationDef(name, { agentFiles, description, color }) {
  if (!name) return null;
  const def = {
    name,
    agentFiles: Array.isArray(agentFiles) ? agentFiles : [],
    description: description || '',
    color: color || 'orange',
  };
  this.designationDefs.set(name, def);
  this._saveState();
  this.emit('designationDefs:changed', this.getDesignationDefs());
  return def;
}

function removeDesignationDef(name) {
  if (!this.designationDefs.has(name)) return false;
  this.designationDefs.delete(name);
  // Clear any session assignments using this designation
  for (const [num, des] of this.designations) {
    if (des === name) this.designations.delete(num);
  }
  this._saveState();
  this.emit('designationDefs:changed', this.getDesignationDefs());
  this.emit('designations:changed', this.getDesignations());
  return true;
}

// ── Agent Roots + File Scanning ─────────────────────────

function getAgentRoots() {
  return this.agentRoots;
}

function setAgentRoots(roots) {
  this.agentRoots = Array.isArray(roots) ? roots : [];
  this._saveState();
  this.emit('agentRoots:changed', this.agentRoots);
}

function scanAgentFiles() {
  const results = [];
  for (const root of this.agentRoots) {
    const expanded = root.replace(/^~/, os.homedir());
    try {
      this._scanDir(expanded, expanded, results);
    } catch {
      // Root doesn't exist or isn't readable
    }
  }
  this.agentFilesList = results;
  this.emit('agentFiles:scanned', this.agentFilesList);
  return this.agentFilesList;
}

function _scanDir(dir, root, results) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      this._scanDir(fullPath, root, results);
    } else if (entry.name.endsWith('.md')) {
      results.push({
        path: fullPath,
        name: entry.name,
        relativePath: path.relative(root, fullPath),
        root,
      });
    }
  }
}

// ── Work States ─────────────────────────────────────────

function getWorkStates() {
  return this.workStates;
}

function setWorkStates(states) {
  if (!Array.isArray(states) || !states.length) return this.workStates;
  this.workStates = states.map(s => ({
    id: s.id || s.label.toLowerCase().replace(/\s+/g, '-'),
    label: s.label || s.id,
    color: s.color || '#6272a4',
    autoOnStatus: Array.isArray(s.autoOnStatus) ? s.autoOnStatus : [],
  }));
  this.emit('workStates:changed', this.workStates);
  this._saveState();
  return this.workStates;
}

module.exports = {
  // Checklist Templates
  getChecklistTemplates,
  setChecklistTemplate,
  removeChecklistTemplate,
  // Session Context
  getSessionContext,
  getAllSessionContexts,
  setSessionContext,
  clearSessionContext,
  // Task Checklist
  toggleChecklistItem,
  addChecklistItem,
  removeChecklistItem,
  setTaskChecklist,
  // Designations
  setDesignation,
  getDesignations,
  getDesignationDefs,
  setDesignationDef,
  removeDesignationDef,
  // Agent Roots + Scanning
  getAgentRoots,
  setAgentRoots,
  scanAgentFiles,
  _scanDir,
  // Work States
  getWorkStates,
  setWorkStates,
};
