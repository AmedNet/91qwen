/**
 * Tool name alias resolution for MCP tools.
 *
 * Upstream sometimes returns tool names with mixed separators in the namespace
 * (e.g. "mcp__js-reverse__break_on_xhr" vs "mcp__js_reverse__break_on_xhr").
 * This module provides a bidirectional alias map so both forms resolve to the
 * same canonical name.
 *
 * = Canonical form =
 *   mcp__<namespace>__<tool_name>
 *
 * Rules:
 *  - namespace separators are normalized to "-"
 *  - tool_name separators are normalized to "_"
 */

const NAMESPACE_ALIASES: Record<string, string> = {
  'camoufox-reverse': 'camoufox-reverse',
  camoufox_reverse: 'camoufox-reverse',
  'cdp-bridge': 'cdp-bridge',
  cdp_bridge: 'cdp-bridge',
  'codex-app': 'codex-app',
  codex_app: 'codex-app',
  'js-reverse': 'js-reverse',
  js_reverse: 'js-reverse',
  'playwright-mcp': 'playwright-mcp',
  playwright_mcp: 'playwright-mcp',
};

const TOOL_ALIASES: Record<string, string> = {
  break_on_xhr: 'break_on_xhr',
  'break-on-xhr': 'break_on_xhr',
  browser_batch: 'browser_batch',
  'browser-batch': 'browser_batch',
  browser_click: 'browser_click',
  'browser-click': 'browser_click',
  browser_close: 'browser_close',
  'browser-close': 'browser_close',
  browser_console_messages: 'browser_console_messages',
  'browser-console-messages': 'browser_console_messages',
  browser_drag: 'browser_drag',
  'browser-drag': 'browser_drag',
  browser_drop: 'browser_drop',
  'browser-drop': 'browser_drop',
  browser_evaluate: 'browser_evaluate',
  'browser-evaluate': 'browser_evaluate',
  browser_file_upload: 'browser_file_upload',
  'browser-file-upload': 'browser_file_upload',
  browser_fill_form: 'browser_fill_form',
  'browser-fill-form': 'browser_fill_form',
  browser_handle_dialog: 'browser_handle_dialog',
  'browser-handle-dialog': 'browser_handle_dialog',
  browser_hover: 'browser_hover',
  'browser-hover': 'browser_hover',
  browser_navigate: 'browser_navigate',
  'browser-navigate': 'browser_navigate',
  browser_navigate_back: 'browser_navigate_back',
  'browser-navigate-back': 'browser_navigate_back',
  browser_network_request: 'browser_network_request',
  'browser-network-request': 'browser_network_request',
  browser_network_requests: 'browser_network_requests',
  'browser-network-requests': 'browser_network_requests',
  browser_press_key: 'browser_press_key',
  'browser-press-key': 'browser_press_key',
  browser_resize: 'browser_resize',
  'browser-resize': 'browser_resize',
  browser_run_code_unsafe: 'browser_run_code_unsafe',
  'browser-run-code-unsafe': 'browser_run_code_unsafe',
  browser_screenshot: 'browser_screenshot',
  'browser-screenshot': 'browser_screenshot',
  browser_select_option: 'browser_select_option',
  'browser-select-option': 'browser_select_option',
  browser_snapshot: 'browser_snapshot',
  'browser-snapshot': 'browser_snapshot',
  browser_tabs: 'browser_tabs',
  'browser-tabs': 'browser_tabs',
  browser_take_screenshot: 'browser_take_screenshot',
  'browser-take-screenshot': 'browser_take_screenshot',
  browser_type: 'browser_type',
  'browser-type': 'browser_type',
  browser_wait: 'browser_wait',
  'browser-wait': 'browser_wait',
  browser_wait_for: 'browser_wait_for',
  'browser-wait-for': 'browser_wait_for',
  check_environment: 'check_environment',
  'check-environment': 'check_environment',
  clear_network_requests: 'clear_network_requests',
  'clear-network-requests': 'clear_network_requests',
  clear_site_data: 'clear_site_data',
  'clear-site-data': 'clear_site_data',
  click_element: 'click_element',
  'click-element': 'click_element',
  compare_env: 'compare_env',
  'compare-env': 'compare_env',
  evaluate_script: 'evaluate_script',
  'evaluate-script': 'evaluate_script',
  export_state: 'export_state',
  'export-state': 'export_state',
  get_paused_info: 'get_paused_info',
  'get-paused-info': 'get_paused_info',
  get_request_initiator: 'get_request_initiator',
  'get-request-initiator': 'get_request_initiator',
  get_script_source: 'get_script_source',
  'get-script-source': 'get_script_source',
  get_storage: 'get_storage',
  'get-storage': 'get_storage',
  get_websocket_messages: 'get_websocket_messages',
  'get-websocket-messages': 'get_websocket_messages',
  hook_function: 'hook_function',
  'hook-function': 'hook_function',
  hook_jsvmp_interpreter: 'hook_jsvmp_interpreter',
  'hook-jsvmp-interpreter': 'hook_jsvmp_interpreter',
  import_state: 'import_state',
  'import-state': 'import_state',
  inject_hook_preset: 'inject_hook_preset',
  'inject-hook-preset': 'inject_hook_preset',
  instrumentation: 'instrumentation',
  intercept_request: 'intercept_request',
  'intercept-request': 'intercept_request',
  launch_browser: 'launch_browser',
  'launch-browser': 'launch_browser',
  list_breakpoints: 'list_breakpoints',
  'list-breakpoints': 'list_breakpoints',
  list_console_messages: 'list_console_messages',
  'list-console-messages': 'list_console_messages',
  list_network_requests: 'list_network_requests',
  'list-network-requests': 'list_network_requests',
  list_scripts: 'list_scripts',
  'list-scripts': 'list_scripts',
  list_trace_files: 'list_trace_files',
  'list-trace-files': 'list_trace_files',
  navigate_page: 'navigate_page',
  'navigate-page': 'navigate_page',
  new_page: 'new_page',
  'new-page': 'new_page',
  pause_or_resume: 'pause_or_resume',
  'pause-or-resume': 'pause_or_resume',
  remove_breakpoint: 'remove_breakpoint',
  'remove-breakpoint': 'remove_breakpoint',
  remove_hooks: 'remove_hooks',
  'remove-hooks': 'remove_hooks',
  reset_browser_state: 'reset_browser_state',
  'reset-browser-state': 'reset_browser_state',
  save_script_source: 'save_script_source',
  'save-script-source': 'save_script_source',
  search_in_sources: 'search_in_sources',
  'search-in-sources': 'search_in_sources',
  select_frame: 'select_frame',
  'select-frame': 'select_frame',
  select_page: 'select_page',
  'select-page': 'select_page',
  set_breakpoint_on_text: 'set_breakpoint_on_text',
  'set-breakpoint-on-text': 'set_breakpoint_on_text',
  apply_patch: 'apply_patch',
  'apply-patch': 'apply_patch',
  codex_app__load_workspace_dependencies: 'codex_app__load_workspace_dependencies',
  'codex-app__load-workspace-dependencies': 'codex_app__load_workspace_dependencies',
  codex_app__navigate_to_codex_page: 'codex_app__navigate_to_codex_page',
  'codex-app__navigate-to-codex-page': 'codex_app__navigate_to_codex_page',
  codex_app__read_thread_terminal: 'codex_app__read_thread_terminal',
  'codex-app__read-thread-terminal': 'codex_app__read_thread_terminal',
  exec_command: 'exec_command',
  'exec-command': 'exec_command',
  list_mcp_resource_templates: 'list_mcp_resource_templates',
  'list-mcp-resource-templates': 'list_mcp_resource_templates',
  list_mcp_resources: 'list_mcp_resources',
  'list-mcp-resources': 'list_mcp_resources',
  read_mcp_resource: 'read_mcp_resource',
  'read-mcp-resource': 'read_mcp_resource',
  request_permissions: 'request_permissions',
  'request-permissions': 'request_permissions',
  request_user_input: 'request_user_input',
  'request-user-input': 'request_user_input',
  take_screenshot: 'take_screenshot',
  'take-screenshot': 'take_screenshot',
  take_snapshot: 'take_snapshot',
  'take-snapshot': 'take_snapshot',
  trace_property_access: 'trace_property_access',
  'trace-property-access': 'trace_property_access',
  type_text: 'type_text',
  'type-text': 'type_text',
  verify_signer_offline: 'verify_signer_offline',
  'verify-signer-offline': 'verify_signer_offline',
  wait_for: 'wait_for',
  'wait-for': 'wait_for',
};

function resolveNamespace(ns: string): string {
  return NAMESPACE_ALIASES[ns] || ns;
}

function resolveTool(tool: string): string {
  return TOOL_ALIASES[tool] || tool;
}

export function resolveToolName(name: string): string {
  const clean = name.startsWith('★-') ? name.slice(2) : name;

  const parts = clean.split('__');
  if (parts.length >= 3 && parts[0] === 'mcp') {
    const namespace = resolveNamespace(parts[1]);
    const tool = resolveTool(parts.slice(2).join('__'));
    return `mcp__${namespace}__${tool}`;
  }

  if (parts.length === 2) {
    const namespace = resolveNamespace(parts[0]);
    const tool = resolveTool(parts[1]);
    return `${namespace}__${tool}`;
  }

  return resolveTool(clean);
}

export function buildToolNameAliases(tools: Array<{ name: string }>): Record<string, string> {
  const aliases: Record<string, string> = {};
  for (const tool of tools) {
    const canonical = resolveToolName(tool.name);
    if (canonical !== tool.name) {
      aliases[tool.name] = canonical;
    }
  }
  return aliases;
}
