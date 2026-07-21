import { sidebarHtml } from './sidebar.ts';

export const accountsHtml = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Qwen Gate — 账户</title>
<link rel="stylesheet" href="/dashboard/static/shared.css">
<link rel="stylesheet" href="/dashboard/static/accounts.css">
</head>
<body>
<div class="dashboard-layout">
${sidebarHtml('accounts')}
  <main class="main-content">
    <div class="page-header">
      <h1>账户</h1>
    </div>

    <!-- Error Display -->
    <div class="error-box" id="errorBox"></div>

    <!-- Add Account Form -->
    <div class="panel">
      <div class="panel-header open">
        <span class="panel-title">添加账户</span>
      </div>
      <div class="panel-body open">
        <div style="font-size:0.75rem;color:var(--text-secondary);margin-bottom:12px;line-height:1.5;background:var(--bg-elevated);padding:10px 14px;border-radius:var(--radius-sm)"><strong>⚠️ 最佳实践：</strong>使用 <strong>3 个以上账户</strong> 进行轮换，以绕过冷却限制。请<strong>勿</strong>使用个人 Qwen 账户——创建专用账户。</div>
        <form class="account-form" id="addForm">
          <input type="email" class="account-input" id="emailInput" placeholder="邮箱" required autocomplete="email">
          <input type="password" class="account-input" id="passwordInput" placeholder="密码" required autocomplete="new-password">
          <button type="submit" class="account-btn" id="addBtn">添加账户</button>
        </form>
      </div>
    </div>

    <!-- Accounts Table -->
    <div class="panel">
      <div class="panel-header open">
        <span class="panel-title">账户列表</span>
        <span id="acctCount" style="font-size:0.7rem;color:var(--text-secondary);font-weight:500"></span>
      </div>
      <div class="panel-body open">
        <div class="tbl-wrap">
          <table id="acctTable">
            <thead>
              <tr>
                <th>邮箱</th>
                <th>认证状态</th>
                <th>进行中</th>
                <th>总请求数</th>
                <th>限流</th>
                <th>Token TTL</th>
                <th>已禁用</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody id="acctBody"></tbody>
          </table>
        </div>
        <div class="empty-state" id="emptyState">尚未配置账户，请在上方添加。</div>
      </div>
    </div>
  </main>
</div>

<!-- Confirmation Modal -->
<div class="modal-overlay" id="confirmOverlay">
  <div class="modal">
    <h3>移除账户</h3>
    <p>确定要移除 <strong id="confirmEmail"></strong>？此操作不可撤销。</p>
    <div class="modal-actions">
      <button class="modal-cancel" id="confirmNo">取消</button>
      <button class="modal-confirm" id="confirmYes">移除</button>
    </div>
  </div>
</div>

<!-- Toast Container -->
<div class="toast-container" id="toastContainer"></div>


  <script src="/dashboard/static/shared.js"></script>
  <script src="/dashboard/static/accounts.js"></script>
</body>
</html>`;
