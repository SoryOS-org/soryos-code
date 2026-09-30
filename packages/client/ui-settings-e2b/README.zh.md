---
description: "dsh Web 客户端插件页上的 E2B 远程沙箱提供方设置页：API Key、密钥引用名、模板与超时。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-e2b

[English](README.md).zh.md) | 中文

## 概述

在侧栏打开**插件**，在官方分组里选择**远程沙箱**，即可设置 E2B 连接的密钥、命名该密钥的引用名、沙箱模板以及两个超时。页面暂存输入、只在保存时写入；密钥通过凭据域写入而不进设置文件，其明文从不出现在任何响应里。页面只在 Host 服务 `e2b` 命名空间期间存在。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

官方分组里的**远程沙箱**卡片打开这一页。**API Key** 每次加载都是空的，只报告是否已配置密钥；留空保存等于保留现有密钥，而当凭据不能从这里写入时（例如由进程环境变量提供的密钥）该控件会被禁用。**密钥引用名**说明密钥存在哪里，默认是 `E2B_API_KEY`；修改它即改为寻址另一个凭据。**控制平面域名**、**沙箱模板**、**沙箱存活时长**和**请求超时**显示生效值，一旦被覆盖就带**已覆盖**标签和**恢复默认**，清空后保存等于重置。点击**保存**之前不会写入任何内容；离开页面即丢弃草稿。

沙箱的 **workspace** 目录不在这一页：它由 E2B preset 拥有，因为它是部署身份而不是单次会话的旋钮。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

Host 一半是空的 `apply`，只为让该包占有一个 Loader 行，供客户端模块系统为浏览器一半提供服务。浏览器一半通过 `ctx.configForms.get` 绑定 `e2b` 命名空间，并把暂存表单放在 `E2bCardController` 中，复用 `ui-primitives` 的 `SettingsFormModel`，其中密钥是表单唯一的密文控件：写入走 `remote.credentials.set`，目标是该 section 的 `apiKeyEnv` 所命名的引用（未命名时为 `E2B_API_KEY`），成功与否再由 `remote.credentials.describe` 读回。当 scope 变化、或 Host 报告被监视的引用发生 `credentials/reference-updated` 时，控制器会重新读取凭据，因为在其他界面写入的密钥不会改变任何 settings section。该页通过 `ctx.configForms.whileServed` 把 `E2bCard` 注册进插件页的 `plugins.item` slot。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [ui-plugin-manager](../ui-plugin-manager/README.zh.md).zh.md) —— 插件页以及该页注册进去的 `plugins.item` slot。
- [ui-settings](../ui-settings/README.zh.md).zh.md) —— settings scope 与该页依赖的命名空间服务监视。
- [ui-primitives](../ui-primitives/README.zh.md).zh.md) —— 该页渲染的 settings 表单模型与字段。
- [credentials](../../credentials/README.zh.md) —— 密钥写入所经的凭据引用 seam。
- [e2b](../../e2b/e2b/README.zh.md) —— 注册 `e2b` 命名空间并解析密钥的连接。

-----

<a id="model-experience"></a>
## 模型体验

无：该包是浏览器侧的设置界面，不注册任何模型界面。

#### KV 缓存影响

无；该包既不组装也不发送任何提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **workspace 目录不能在此编辑**——`E2bConnection.Config.workspace` 仍是普通字段，因此部署能下发的只有 preset 的取值；要修改就得改 profile。
- **没有沙箱生命周期控件**——该页只做配置，不创建、暂停、恢复或销毁沙箱；那些是 agent 发起的服务调用。
- **运行时不变式：**未发布伴随模块。该页不持有任何自有关系：它显示的内容来自 settings mirror 与凭据域，它写入的内容由 Host 校验。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
