# DSH 插件注册机制与 QR 扫码配对实现调研报告

**调研对象**：`dsh-remote-mobile` (v1.7.0，公开仓库：[IceApriler/dsh-remote-mobile](https://github.com/IceApriler/dsh-remote-mobile))  
**调研日期**：2026-09-27  
**核心关注点**：
1. **符合 DSH 规范的插件注册方式**（如何在 DSH 原生菜单与设置面板中配置与呈现）；
2. **QR 扫码配对机制**（配对码生成、二维码构造、移动端扫码验证、会话建立与实时状态同步的全流程实现）；
3. **与 DSH Orbit 架构的对比与安全借鉴边界**。

---

## 1. 调研背景与目标项目概况

`dsh-remote-mobile` 是 DeepSeek Harness (DSH) 生态中一个专注解决远程移动端访问与安全门禁的开源插件。该插件在社区中验证了“无需修改 DSH 核心代码，直接在 DSH 桌面端设置菜单中配置，并通过手机扫码完成一键配对”的用户体验闭环。

通过对其 npm 发布包（v1.7.0）的源码反编译与静态架构分析，其核心代码组织如下：
- `package.json` & `cordis.patch.yml`：Cordis 插件与 DSH 前端 Client 注入元数据声明；
- `lib/index.js`：服务端入口，挂载 Cordis 上下文、注入 DSH Settings 服务、注册 Web 路由；
- `lib/client.js`：前端客户端 Bundle，向 DSH 前端 UI 插槽（`slots`）注入「远程与移动端」设置页；
- `lib/routes/api.js` & `lib/routes/login-page.js`：配对码生成、验证与移动端登录引导页面；
- `lib/auth/token.js` & `lib/auth/crypto.js`：短码生成、RSA-OAEP 加密、会话存储与防暴力破解；
- `lib/bridge/compat.js`：底层 connection 接管、上下文虚拟化与生态插件桥接。

---

## 2. 关键点一：符合 DSH 规范的插件注册与菜单配置实现

DSH 底座采用基于 **Cordis**（微内核依赖注入容器）的插件架构，同时其前端桌面/Web 端提供了一套插槽注入机制（`slots`）。`dsh-remote-mobile` 完整遵循了这套前后端双向注册标准。

### 2.1 插件打包与分发元数据声明 (`package.json`)

在 `package.json` 中，插件通过以下字段声明与 DSH 底座的对接契约：

```json
{
  "name": "dsh-remote-mobile",
  "version": "1.7.0",
  "type": "module",
  "main": "lib/index.js",
  "types": "lib/index.d.ts",
  "keywords": [
    "dsh",
    "dsh-plugin",
    "cordis-plugin",
    "deepseek",
    "remote-access",
    "mobile"
  ],
  "exports": {
    ".": "./lib/index.js",
    "./client": "./lib/client.js",
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./package.json": "./package.json"
  },
  "dsh": {
    "bundle": {
      "patch": "./cordis.patch.yml"
    },
    "client": {
      "inject": [
        "@deepseek-ai/dsh-client-runtime",
        "@deepseek-ai/dsh-client-connection",
        "@deepseek-ai/dsh-client-ui-settings",
        "@deepseek-ai/dsh-client-ui-sidebar"
      ],
      "platform": "web"
    }
  }
}
```

- **`cordis.patch.yml` 补丁声明**：
  ```yaml
  - insert:
      - id: remote-mobile
        name: 'dsh-remote-mobile'
  ```
  该补丁指导 DSH 插件加载器在容器启动时，将 `dsh-remote-mobile` 注册进 Cordis 服务树。
- **`dsh.client` 前端注入声明**：
  声明在 Web 平台上注入 `@deepseek-ai/dsh-client-ui-settings` 等前端服务，允许客户端 Bundle（`lib/client.js`）访问 DSH UI 插槽。

---

### 2.2 服务端注册与 Settings 统一持久化 (`lib/index.js`)

在服务端，插件定义标准 Cordis 插件接口，并接入 DSH 的配置管理服务：

```javascript
export const name = 'dsh-remote-mobile';
export const REMOTE_MOBILE_SETTINGS_NAMESPACE = 'dsh-remote-mobile';
export const inject = ['webServer']; // 声明依赖注入 DSH 内置的 webServer

export function apply(ctx, config = {}) {
  const store = new SessionStore(config);
  
  // 1. 接入 DSH Settings 服务
  bindDshSettings(ctx, store);

  // 2. 挂载 WebServer API 路由
  if (ctx.webServer && typeof ctx.webServer.register === 'function') {
    const routes = createRoutes(store, styleStore);
    for (const route of routes) {
      ctx.webServer.register(route);
    }
  }

  // 3. 透明接管 DSH connection 鉴权服务 (绕过官方临时 Token 401 阻断)
  attachConnectionAuth(ctx.get('connection'));
}
```

#### Settings 服务的双向绑定逻辑：
插件并不自行发明独立的配置文件，而是通过 DSH 底座提供的 `settings` 服务，将配置保存在 DSH 全局配置文件 `~/.dsh/settings.yaml` 中专属的 `dsh-remote-mobile` 命名空间下：

```javascript
function bindDshSettings(ctx, store) {
  const settingsService = ctx.get('settings');
  if (!settingsService?.register) return;

  const ns = 'dsh-remote-mobile';
  const scope = settingsService.register(ns, undefined, {
    base: store.getOptions(),
  });

  if (scope) {
    // 1. 初始读取：从 settings.yaml 载入配置
    const initialVal = scope.get?.();
    if (initialVal) store.updateOptions(initialVal, false);

    // 2. 监听外部变更：用户在其他界面或手动修改 settings.yaml 时自动同步
    scope.watch?.(() => {
      const updated = scope.get?.();
      if (updated) store.updateOptions(updated, false);
    });

    // 3. 反向写回钩子：插件前端或 API 变更配置时原子写回 settings.yaml
    store.setSettingsMutator((patch) => {
      const ops = Object.entries(patch).map(([field, value]) => ({
        op: 'set',
        path: [field],
        value,
      }));
      settingsService.mutate?.(ns, ops);
    });
  }
}
```

---

### 2.3 客户端 UI 菜单插槽注入 (`lib/client.js`)

在前端，插件通过 DSH 客户端上下文暴露的 `slots` 服务，在 DSH 原生设置窗口中插入自己的配置项：

```javascript
export function apply(ctx) {
  if (typeof window === "undefined") return;

  // 获取 DSH 前端插槽服务
  var slots = (ctx && typeof ctx.get === "function") ? ctx.get("slots") : ctx.slots;

  if (slots && typeof slots.inject === "function") {
    slots.inject("settings.section", function() {
      // 注册设置菜单项
      var unregister = slots.register({
        name: "settings.section",
        id: "tailscale-mobile",
        order: 150, // 排序权重
        label: function() {
          var lang = resolveLocale(ctx);
          return lang === "en" ? "Remote & Mobile" : "远程与移动端";
        }
      }, TailscaleMobileSection); // 传入 React UI 组件

      return function() {
        if (typeof unregister === "function") unregister();
      };
    });
  }
}
```

**呈现效果与能力**：
- 用户点击 DSH 左侧边栏的「设置」齿轮图标；
- 设置对话框左侧菜单树中出现「远程与移动端」选项（顺序由 `order: 150` 决定）；
- 右侧主区域直接渲染 `TailscaleMobileSection` 组件：
  - 显示网络 IP 状态（本机回环、局域网 IP、Tailscale IP）；
  - 免密直连切换开关；
  - 扫码配对卡片（展示二维码、动态 6 位短码、倒计时、一键刷新）；
  - 长期密码设置输入框；
  - 已授权设备列表（设备名称、认证方式、IP、最后活跃时间、单设备撤销按钮、一键全撤按钮）；
  - 防暴力破解安全统计与被锁 IP 解除按钮。

---

## 3. 关键点二：QR 扫码配对机制与全流程实现

QR 配对的目标是**消除在移动端手动输入长 URL、复杂端口或长 Token 的繁琐操作**，实现“电脑端一键出码，手机端扫码即连”。

### 3.1 扫码配对技术架构与序列图

```text
  [PC 桌面端 DSH 设置页]               [DSH 插件后端]                  [手机移动端浏览器]
          │                                  │                                │
 1. 打开「远程与移动端」                       │                                │
    调用 generate-code ────────────────────>│                                │
          │                            生成 6 位短码                           │
          │                            + 5 分钟定时器                          │
          │<───────────────────────── 返回 { code, expiresAt }                │
 2. 前端根据 IP:Port + code                   │                                │
    绘制纯 SVG 矢量二维码                     │                                │
          │                                  │                                │
          │                                  │   3. 手机扫码打开 URL           │
          │                                  │   /auth?token=849201           │
          │                                  │<───────────────────────────────│
          │                                  │─── 下发 /auth 登录页 ─────────>│
          │                                  │    自动回填 token 到输入框      │
          │                                  │                                │
          │                                  │   4. 点击授权（RSA 加密提交）  │
          │                                  │      POST /verify              │
          │                                  │<───────────────────────────────│
          │                                  │ RSA 私钥解密                   │
          │                                  │ 校验短码并立即核销 (防重放)    │
          │                                  │ 签发 365 天 Session Token      │
          │                                  │─── Set-Cookie + 200 OK ───────>│
          │                                  │                                │
          │  5. SSE 实时推送                 │                                5. 自动跳转入工作区
          │     event: device-connected      │                                   GET / 成功放行
          │<─────────────────────────────────│                                │
 6. 弹窗提示「新设备已连接」                  │                                │
    自动无刷新增加设备卡片                    │                                │
```

---

### 3.2 步骤详解与核心代码分析

#### 步骤 1：短码与短期配对记录生成 (`lib/auth/token.js`)
前端在设置页加载或点击“刷新配对码”时，发起 `POST /api/remote-mobile/generate-code`。
服务端生成 6 位纯数字与 24 字节随机 Token：

```javascript
generateShortCode() {
  const code = randomInt(100000, 1000000).toString(); // 6 位随机纯数字
  const token = "<random-token>"; // 实际生成为 randomBytes(24).toString("hex")
  const now = Date.now();
  const expiresAt = now + 5 * 60 * 1000; // 严格 5 分钟有效期

  const record = { code, token, createdAt: now, expiresAt };
  this.shortCodes.set(code, record);
  this.shortCodes.set(token, record);

  // 5 分钟后自动销毁内存记录，unref 避免阻断 Node 退出
  const timer = setTimeout(() => {
    this.shortCodes.delete(code);
    this.shortCodes.delete(token);
  }, 5 * 60 * 1000 + 1000);
  timer.unref?.();

  return { code, token, expiresAt };
}
```

#### 步骤 2：二维码在客户端的构建与呈现 (`lib/client.js`)
前端组件获取当前网络地址与配对码后，构造配对链接：

```javascript
// 优先选择用户切换的 Tab (Tailscale IP 或 LAN 局域网 IP)
const currentHost = (selectedTab === "lan" && status.lanIp) 
  ? status.lanIp 
  : (status.tailscaleIp || status.lanIp || window.location.hostname || "127.0.0.1");

const directLink = `http://${currentHost}:${port}/auth?token=${status.code || ""}`;
```

- **纯前端零网络依赖 SVG 二维码生成**：
  插件内嵌了一个轻量级的纯 JS 模块 `generateQrSvg(text, size)`（基于经典 QR8bitByte 与多项式纠错算法），将 `directLink` 直接转换为内联 `<svg>` 节点，渲染在 PC 设置面板中。
- **无须调用第三方接口**：杜绝了将本地内网 IP 或配对码泄露给在线二维码生成 API 的隐私风险。
- **大字号短码备选**：二维码旁同时展示醒目的 `849 201` 格式纯文本，照顾无法扫码时的手动输入需求。

#### 步骤 3：移动端扫码与自动回填 (`lib/routes/login-page.js`)
手机相机或扫码器扫描二维码后，自动访问 `http://<IP>:<Port>/auth?token=849201`。
- 服务端返回专属的移动端认证页面（响应式、支持暗黑模式）；
- 页面 JavaScript 解析 URL 查询参数：
  ```javascript
  const urlParams = new URLSearchParams(window.location.search);
  const queryToken = urlParams.get('token');
  if (queryToken) {
    input.value = queryToken; // 仅自动回填输入框
  }
  ```
  *安全设计*：**只回填输入框，不自动提交**。防止爬虫抓取链接或微信/Safari 预加载机制误消耗掉一次性配对码。

#### 步骤 4：端到端加密与安全提交
用户点击“立即授权连接”按钮时：
1. **RSA-OAEP 传输加密**：
   - 页面内置服务端启动时生成的 2048 位 RSA 公钥；
   - 优先通过浏览器的 Web Crypto API 进行非对称加密：`window.crypto.subtle.encrypt({ name: 'RSA-OAEP', hash: 'SHA-256' }, ...)`；
   - 若在非安全上下文（纯 HTTP + 局域网 IP，部分手机浏览器禁用 `crypto.subtle`），自动平滑降级至内置的纯 JS RSA 模幂运算垫片，保证配对码/密码绝不明文通过局域网广播。
2. 发起验证请求：`POST /api/remote-mobile/verify`，Body 为 `{ encryptedCredential: "..." }`。

#### 步骤 5：服务端验证、长效会话签发与核销
在 `lib/routes/api.js` 与 `lib/auth/token.js` 中：
1. **私钥解密**：使用服务端私钥解密得到明文短码；
2. **防暴力破解检测**：检查客户端 IP 的失败计数，若大于阈值（默认 5 次）则返回 429 锁定；
3. **一次性核销**：
   ```javascript
   const short = this.shortCodes.get(trimmed);
   if (short) {
     if (short.expiresAt < now) {
       this.shortCodes.delete(short.code);
       return { success: false, reason: '配对码已过期，请在 PC 上刷新获取' };
     }
     // 核心：立即销毁短码，杜绝二次重放
     this.shortCodes.delete(short.code);
     this.shortCodes.delete(short.token);

     // 签发 365 天长效会话 Token
     const sessionToken = randomBytes(32).toString('hex');
     const session = {
       token: sessionToken,
       createdAt: now,
       lastSeenAt: now,
       ip,
       deviceName: parseDeviceName(userAgent), // 解析例如 "📱 iPhone (Safari)"
       authType: '扫码配对码 (365天免登)',
     };
     this.sessions.set(sessionToken, session);
     this.savePersistedData(); // 原子落盘到 ~/.dsh/devices.json

     // 触发事件通知
     this.emit('device-connected', session);
     return { success: true, token: sessionToken };
   }
   ```
4. **Cookie 写入与跳转**：
   响应头写入 `Set-Cookie: dsh_mobile_token=<token>; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax`。
   手机端收到 200 成功响应后，自动跳转至 `/` 根目录。

#### 步骤 6：桌面端 SSE 实时感知设备接入
桌面端在打开设置面板时，通过 `EventSource` 订阅了 `/api/remote-mobile/events`：
- 服务端触发 `this.emit('device-connected', session)` 后，SSE 通道立即向桌面端下发数据：
  `data: {"type":"device-connected","device":{...}}`
- 桌面端监听到事件后：
  1. 触发全局 Toast 弹窗：“📱 发现新设备已连接：iPhone (Safari) (客户端 IP)”；
  2. 设备管理表格无刷新自动更新，操作员立刻就能看到新授权的设备并可随时一键“撤销”。

---

## 3. DSH Orbit 架构对比与安全边界裁决

`dsh-remote-mobile` 提供了出色的易用性参考，但由于其定位是单体玩具/局域网小工具，其内部存在若干严重违背企业级安全设计与 Orbit 治理原则的缺陷。Orbit 在后续规划相关功能时必须明确以下边界：

| 维度 | `dsh-remote-mobile` 做法 | DSH Orbit 架构规范与底线原则 | 借鉴 / 裁决结论 |
|:---|:---|:---|:---|
| **DSH 插件注册机制** | 使用 `cordis.patch.yml` + `slots.inject('settings.section')` | Orbit 架构规划可支持开发官方 DSH 适配插件，通过标准插槽在 DSH 中呈现管理入口 | **采纳借鉴**：标准插槽注册模式是原生的无侵入方案，优于硬改 DSH 代码。 |
| **配置持久化** | 接入 DSH Settings 服务写回 `~/.dsh/settings.yaml` | Orbit Hub 拥有独立的 SQLite 数据库，但对于安装在 DSH 节点上的 Node 插件，可使用 DSH settings 存放节点侧轻量级偏好 | **采纳借鉴**：遵循 DSH 官方 Settings 命名空间规范。 |
| **QR 扫码交互流** | 6 位数字短码 / 5 分钟失效 / 前端内联 SVG 生成 / URL 带参回填 / SSE 实时通知 | Orbit 的节点配对（Pairing）或操作员移动端 Bootstrap 可完全沿用该交互流程 | **采纳借鉴**：零网络依赖的前端 SVG 渲染和一次性短码换会话体验极佳。 |
| **网络与 Authority 模型** | **破坏性虚拟回环**：将所有外部请求的 Host、Origin 强行篡改成 `127.0.0.1` 绕过 DSH 安全校验 | **严格 Authority 隔离**：Orbit 强制区分公网入口与机器入口，严格校验 Host/Origin 避免 DNS-Rebinding 与跨站写攻击 | **严禁照搬**：Orbit 绝不篡改 Host/Origin，必须使用标准的独立反向代理或网关边界。 |
| **设备与节点概念** | 混淆概念：将一个浏览器的 Cookie 会话直接叫做“设备（Device）” | **严谨分层**：Orbit 严格区分“操作员浏览器会话（Operator Session）”与“受控 DSH 节点（Node）” | **严禁照搬**：扫码授权的是操作员浏览器设备，绝不能赋予其 DSH 节点的机器控制凭据。 |
| **会话有效期与凭据** | 扫码一次即签发 365 天超长明文 Token，支持 LAN 完全免密 | **严格生命周期管理**：操作员会话受短 TTL、滚动刷新、CSRF Token 保护，禁止长效固定凭据与局域网无条件免密 | **严禁照搬**：必须保持 Orbit 现有的安全生命周期与审计追踪。 |
| **传输安全保障** | 在纯 HTTP 裸协议上跑前端 JS RSA 加密垫片 | **强制标准 TLS**：所有节点配对、流量转发与网关访问必须经由受信任的 TLS（支持自定义 CA 或自签名指纹校验） | **严禁照搬**：前端 JS 加密无法替代传输层 TLS，极易遭受剥离攻击。 |

---

## 4. 总结与后续落地建议

本次调研明确了该项目的两个核心技术机制：
1. **符合规范的插件注册**：通过 `cordis.patch.yml` 注入 Cordis 容器，服务端利用 `ctx.get('settings').register()` 接入 DSH 全局配置，客户端通过 `ctx.get('slots').inject('settings.section', ...)` 将原生 React 选项卡挂载到 DSH 的「设置」窗口内。
2. **QR 扫码配对**：服务端生成 5 分钟有效的 6 位一次性随机数字短码，前端内置轻量 SVG 算法生成二维码，手机扫码带参打开登录页回填，提交后服务端核销短码、签发会话，并通过 SSE 实时通知桌面端刷新。

后续若在 Orbit 中启动移动端接入或扫码配对相关需求（例如规划 v0.9 或相关扩展功能），建议：
- **UX 层完全借鉴**其轻量内联 SVG 二维码生成、6 位短码回填与 SSE 实时同步交互；
- **插件层完全兼容**其 DSH `settings.section` 插槽注册与 `~/.dsh/settings.yaml` 命名空间配置规范；
- **安全与网络层严格坚守** Orbit 的 TLS 传输加密、确定性 Authority 边界、严格 CSRF 校验与操作员/节点身份隔离体系，绝不引入虚拟回环伪造等不安全捷径。
