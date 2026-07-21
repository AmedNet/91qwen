function fmtTTL(ms) {
  if (ms == null || ms < 0) return '\u2014';
  var m = Math.floor(ms / 60000),
    h = Math.floor(m / 60);
  m %= 60;
  if (h > 0) return h + 'h ' + m + 'm';
  return m + 'm';
}

function showToast(message, type) {
  var container = document.getElementById('toastContainer');
  var toasts = container.querySelectorAll('.toast');
  while (toasts.length >= 5) {
    toasts[0].remove();
    toasts = container.querySelectorAll('.toast');
  }
  var toast = document.createElement('div');
  toast.className = 'toast ' + (type || 'info');
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(function () {
    if (toast.parentNode) toast.remove();
  }, 3500);
}

function setError(msg) {
  var box = document.getElementById('errorBox');
  if (msg) {
    box.textContent = msg;
    box.style.display = '';
  } else {
    box.style.display = 'none';
  }
}

/* ── Accounts Table ── */
function getAuthStatus(acct) {
  if (acct.startupStatus === 'connecting') return 'connecting';
  if (acct.startupStatus === 'initializing' || acct.startupStatus === 'pending') {
    return 'pending';
  }
  if (acct.throttled) return 'throttled';
  if (acct.authenticated) return 'live';
  if (acct.tokenExpiresInMs != null && acct.tokenExpiresInMs < 0) return 'expired';
  return 'unknown';
}

function getAuthLabel(status) {
  if (status === 'live') return '已认证';
  if (status === 'pending') return '启动中...';
  if (status === 'connecting') return '连接中...';
  if (status === 'expired') return '已过期';
  if (status === 'throttled') return '已限流';
  return '未认证';
}

function makeThrottleBadge(acct) {
  if (acct.throttled) {
    var label = '已限流';
    if (acct.throttledUnlockAt) {
      var unlockTime = new Date(acct.throttledUnlockAt);
      var timeStr = unlockTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      label += '，解禁时间 ' + timeStr;
    } else if (acct.throttledRemainingMs != null) {
      label += ' ' + fmtTTL(acct.throttledRemainingMs);
    }
    return '<span class="badge badge-warning">' + label + '</span>';
  }
  return '<span class="badge badge-neutral">正常</span>';
}

function renderAccountsTable(accts) {
  if (!Array.isArray(accts) || accts.length === 0) {
    document.getElementById('acctBody').innerHTML = '';
    document.getElementById('emptyState').style.display = '';
    setText('acctCount', '');
    return;
  }
  document.getElementById('emptyState').style.display = 'none';
  setText('acctCount', accts.length + ' 个账户');
  var rows = '';
  for (var i = 0; i < accts.length; i++) {
    var a = accts[i];
    var status = getAuthStatus(a);
    var label = getAuthLabel(status);
    var hideLogin = status === 'live' ? ' style="display:none"' : '';
    rows +=
      '<tr>' +
      '<td>' +
      escHtml(a.email) +
      '</td>' +
      '<td><div class="auth-status"><span class="auth-dot ' +
      status +
      '"></span>' +
      label +
      '</div></td>' +
      '<td>' +
      (a.inFlight || 0) +
      '</td>' +
      '<td>' +
      (a.totalRequests || 0) +
      '</td>' +
      '<td>' +
      makeThrottleBadge(a) +
      '</td>' +
      '<td style="font-family:var(--mono);font-size:0.75rem">' +
      fmtTTL(a.tokenExpiresInMs) +
      '</td>' +
      '<td>' +
      '<span class="toggle-trigger" onclick="handleToggleDisabled(event,\'' +
      escHtml(a.email) +
      "'," +
      a.disabled +
      ')">' +
      '<span class="toggle-track' +
      (a.disabled ? ' active' : '') +
      '">' +
      '<span class="toggle-thumb"></span>' +
      '</span></span>' +
      '</td>' +
      '<td><div class="action-cell">' +
      '<button class="account-btn small danger" data-email="' +
      escHtml(a.email) +
      '" data-action="remove">移除</button>' +
      '<button class="account-btn small primary" data-email="' +
      escHtml(a.email) +
      '" data-action="login"' +
      hideLogin +
      '>登录</button>' +
      '</div></td></tr>';
  }
  document.getElementById('acctBody').innerHTML = rows;
}

/* ── Load Accounts ── */
async function loadAccounts() {
  var data = await apiFetch('/accounts');
  renderAccountsTable(data);
}

/* ── Add Account ── */
function handleAdd(email, password) {
  var btn = document.getElementById('addBtn');
  btn.disabled = true;
  btn.textContent = '添加中...';
  setError(null);
  (async function () {
    try {
      var res = await fetch('/api/accounts', {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
        body: JSON.stringify({ email: email, password: password }),
      });
      var result;
      try {
        result = await res.json();
      } catch {
        result = null;
      }
      if (!res.ok) {
        throw new Error(
          result && result.error && result.error.message ? result.error.message : '添加账户失败 (' + res.status + ')',
        );
      }
      if (result.loginSucceeded) {
        showToast('账户已添加并登录: ' + email, 'success');
        pollAuth(email, 15);
      } else {
        showToast(result.loginError || '账户已添加但登录失败。请点击登录按钮在浏览器中完成认证。', 'warning');
        pollAuth(email, 15);
      }
      loadAccounts();
    } catch (e) {
      setError(e.message);
      showToast(e.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = '添加账户';
    }
  })();
}

/* ── Remove Account ── */
function handleRemove(email) {
  document.getElementById('confirmEmail').textContent = email;
  document.getElementById('confirmOverlay').classList.add('open');
  document.getElementById('confirmYes').onclick = async function () {
    document.getElementById('confirmOverlay').classList.remove('open');
    setError(null);
    try {
      var res = await fetch('/api/accounts/' + encodeURIComponent(email), {
        method: 'DELETE',
        headers: authHeaders(),
      });
      var result;
      try {
        result = await res.json();
      } catch {
        result = null;
      }
      if (!res.ok) {
        throw new Error(
          result && result.error && result.error.message ? result.error.message : '移除账户失败 (' + res.status + ')',
        );
      }
      showToast('账户已移除: ' + email, 'success');
      loadAccounts();
    } catch (e) {
      setError(e.message);
      showToast(e.message, 'error');
    }
  };
  document.getElementById('confirmNo').onclick = function () {
    document.getElementById('confirmOverlay').classList.remove('open');
  };
}

/* ── Manual Login (Autofill) ── */
function handleManualLogin(email) {
  var btn = document.querySelector('button[data-email="' + escHtml(email) + '"][data-action="login"]');
  if (btn) {
    btn.textContent = '认证中...';
    btn.disabled = true;
  }
  setError(null);
  (async function () {
    try {
      var res = await fetch('/api/accounts/' + encodeURIComponent(email) + '/autofill', {
        method: 'GET',
        headers: authHeaders(),
      });
      var result;
      try {
        result = await res.json();
      } catch {
        result = null;
      }
      if (!res.ok) {
        throw new Error(result && result.error && result.error.message ? result.error.message : '登录失败 (' + res.status + ')');
      }
      showToast('已为 ' + email + ' 打开浏览器。请在浏览器中完成登录。', 'info');
      pollAuth(email, 30);
    } catch (e) {
      setError(e.message);
      showToast(e.message, 'error');
    }
  })();
}

/* ── Poll Auth ── */
var activePollTimers = {};
function pollAuth(email, maxAttempts) {
  if (activePollTimers[email]) {
    clearInterval(activePollTimers[email]);
    delete activePollTimers[email];
  }
  var attempt = 0;
  var timer = setInterval(async function () {
    attempt++;
    try {
      var data = await apiFetch('/accounts');
      if (!Array.isArray(data)) {
        clearInterval(timer);
        delete activePollTimers[email];
        return;
      }
      for (var i = 0; i < data.length; i++) {
        if (data[i].email === email && data[i].authenticated) {
          clearInterval(timer);
          delete activePollTimers[email];
          showToast('登录完成: ' + email, 'success');
          loadAccounts();
          return;
        }
      }
    } catch {
      clearInterval(timer);
      delete activePollTimers[email];
    }
    if (attempt >= maxAttempts) {
      clearInterval(timer);
      delete activePollTimers[email];
      loadAccounts();
    }
  }, 2000);
  activePollTimers[email] = timer;
}

/* ── Toggle Disabled ── */
async function handleToggleDisabled(event, email, currentlyDisabled) {
  event.stopPropagation();
  var newDisabled = !currentlyDisabled;
  var res = await fetch('/api/accounts/' + encodeURIComponent(email), {
    method: 'PATCH',
    headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
    body: JSON.stringify({ disabled: newDisabled }),
  });
  if (res.ok) {
    showToast(email + ' ' + (newDisabled ? '已禁用' : '已启用'), 'success');
    loadAccounts();
  } else {
    var err = await res.json().catch(function () {
      return { error: 'Failed' };
    });
    showToast(err.error || 'Failed to toggle', 'error');
  }
}

/* ── Init ── */
function init() {
  /* Load on start */
  loadAccounts();

  /* Auto-poll every 2 seconds */
  createPoller(loadAccounts, 2000);

  /* Add form submit */
  document.getElementById('addForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var email = document.getElementById('emailInput').value.trim();
    var password = document.getElementById('passwordInput').value;
    if (!email || !password) {
      showToast('邮箱和密码为必填项', 'error');
      return;
    }
    handleAdd(email, password);
    this.reset();
  });

  /* Table button delegation */
  document.getElementById('acctTable').addEventListener('click', function (e) {
    var btn = e.target;
    if (btn.tagName !== 'BUTTON') return;
    var email = btn.getAttribute('data-email');
    var action = btn.getAttribute('data-action');
    if (!email || !action) return;
    if (action === 'login') handleManualLogin(email);
    else if (action === 'remove') handleRemove(email);
  });

  /* Close modal on overlay click */
  document.getElementById('confirmOverlay').addEventListener('click', function (e) {
    if (e.target === this) this.classList.remove('open');
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
