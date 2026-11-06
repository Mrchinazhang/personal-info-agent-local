/**
 * 本地离线版配置
 * ------------------------------------------------------------------
 * 这里没有任何密钥、资源 ID 或账号信息，全部是本机占位值，可以安全提交。
 *
 * 原版 app.js 顶部会读 window.PUBLIC_CONFIG.endpoint 等字段并传给
 * WorkBuddyCloud.createWorkBuddyCloud(...)，所以这几个键必须存在；
 * 本地兼容层会忽略它们，改用同源的 /api 前缀请求本机 Flask。
 *
 * 真正的 Ollama 地址配置在 server.py 里（默认 http://127.0.0.1:11434），
 * 浏览器永远不直连模型服务，也就不存在跨域和密钥泄露问题。
 */
window.PUBLIC_CONFIG = {
  resourceId: 'local',
  endpoint: '',
  oauthRelayBaseUrl: '',
  publishableKey: 'local',

  // 本机 Flask 提供的 API 前缀，同源请求，无需域名或证书
  apiBase: '/api'
}
