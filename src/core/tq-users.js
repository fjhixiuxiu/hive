const log = require('./log');

const ALL_PERMISSIONS = ['view', 'comment', 'create-tasks', 'send-messages', 'cancel', 'restart', 'dispatch', 'admin'];

// ── Users + Permissions ─────────────────────────────────

function ensureUser(login, name, avatar) {
  if (!login) return null;
  // Case-insensitive lookup: user may have been pre-added with lowercase key
  let user = this.users.get(login) || this.users.get(login.toLowerCase());
  if (user) {
    // Update profile fields on each login
    if (name) user.name = name;
    if (avatar) user.avatar = avatar;
    this.emit('users:changed', this.getUsersList());
    this._saveState();
    return user;
  }
  // First user ever, or env-specified admin
  const adminUser = process.env.HIVE_ADMIN_USER;
  const isFirstUser = this.users.size === 0;
  const isAdmin = isFirstUser || (adminUser && adminUser.toLowerCase() === login.toLowerCase());
  user = {
    login,
    name: name || login,
    avatar: avatar || '',
    permissions: isAdmin ? [...ALL_PERMISSIONS] : ['view', 'comment'],
    firstSeen: Date.now(),
  };
  this.users.set(login, user);
  this.emit('users:changed', this.getUsersList());
  this._saveState();
  log.info(`[auth] User "${login}" registered (${isAdmin ? 'admin' : 'viewer'})`);
  return user;
}

function hasPermission(login, capability) {
  if (!login) return false;
  const user = this.users.get(login);
  if (!user) return false;
  if (user.permissions.includes('admin')) return true;
  return user.permissions.includes(capability);
}

function setUserPermissions(login, permissions) {
  const user = this.users.get(login);
  if (!user) return null;
  user.permissions = permissions.filter(p => ALL_PERMISSIONS.includes(p));
  this.emit('users:changed', this.getUsersList());
  this._saveState();
  return user;
}

function getUser(login) {
  return this.users.get(login) || null;
}

function getUsersList() {
  return Array.from(this.users.values());
}

function addUser(login, permissions) {
  if (!login) return null;
  login = login.trim().toLowerCase();
  if (this.users.has(login)) return this.users.get(login); // already exists
  const user = {
    login,
    name: login,
    avatar: '',
    permissions: Array.isArray(permissions) ? permissions : ['view', 'comment'],
    firstSeen: Date.now(),
  };
  this.users.set(login, user);
  this.emit('users:changed', this.getUsersList());
  this._saveState();
  log.info(`[auth] User "${login}" pre-added by admin`);
  return user;
}

function removeUser(login) {
  if (!login) return false;
  login = login.trim().toLowerCase();
  if (!this.users.has(login)) return false;
  this.users.delete(login);
  this.emit('users:changed', this.getUsersList());
  this._saveState();
  log.info(`[auth] User "${login}" removed by admin`);
  return true;
}

// ── Task Comments ───────────────────────────────────────

function addComment(taskId, authorLogin, authorName, text) {
  const task = this.tasks.get(taskId);
  if (!task) return null;
  if (!task.comments) task.comments = [];
  const comment = {
    id: `c-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    author: authorLogin,
    authorName: authorName || authorLogin,
    text,
    createdAt: Date.now(),
  };
  task.comments.push(comment);
  this.emit('task:comment:added', { taskId, comment });
  this._saveState();
  return comment;
}

function deleteComment(taskId, commentId, requestingLogin) {
  const task = this.tasks.get(taskId);
  if (!task || !task.comments) return false;
  const idx = task.comments.findIndex(c => c.id === commentId);
  if (idx < 0) return false;
  const comment = task.comments[idx];
  // Only author or admin can delete
  if (comment.author !== requestingLogin && !this.hasPermission(requestingLogin, 'admin')) {
    return false;
  }
  task.comments.splice(idx, 1);
  this.emit('task:comment:deleted', { taskId, commentId });
  this._saveState();
  return true;
}

module.exports = {
  ALL_PERMISSIONS,
  ensureUser,
  hasPermission,
  setUserPermissions,
  getUser,
  getUsersList,
  addUser,
  removeUser,
  addComment,
  deleteComment,
};
