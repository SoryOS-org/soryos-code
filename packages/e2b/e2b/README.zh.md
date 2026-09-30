---
description: "面向配置单个沙箱创建、接管、暂停、恢复、销毁与工作区目录的运维者与智能体，说明 E2B 远端沙箱连接。"
kind: "package-reference"
---

# @deepseek-ai/dsh-e2b

[English](README.md) | 中文

## 概述

`dsh-e2b` 为一份组合配置持有单个 E2B 远端沙箱：创建它、按 ID 接管已有沙箱、暂停并恢复它、销毁它，并初始化其工作区目录。生命周期调用一次只运行一个，因此 `status()` 只报告一种状态——`absent`、`starting`、`ready`、`paused` 或 `failed`——并附带最近一次失败消息。部署方 API 密钥来自配置或环境变量，每次控制平面调用都携带配置的截止时限。当工作应当在 E2B 沙箱内运行，而 Harness、模型传输与 Session 存储留在主机时，选择本包。

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

当一份组合配置需要持有单个由部署方选定的 E2B 沙箱并通过 `ctx.e2b` 驱动它时，加载 `dsh-e2b`；消费方从 `ctx.e2b.sandbox` 读取沙箱句柄。

### 何时使用

当执行应当位于 E2B 隔离的远端虚拟机内，而文件、模型传输与会话记录留在主机时，选择本包。该连接至多持有一个沙箱：已持有时再次 `create` 或 `connect` 会被拒绝。只在主机上执行的组合配置不要使用本包；本地子进程提供方与主机[沙箱](../../../docs/subsystems/sandbox.zh.md)后端无需远端虚拟机即可限制那些工作。

### 配置连接

通过组合配置项加载本包；必填字段是 `initWorkspace` 在沙箱内创建的绝对目录。

```yaml
- name: '@deepseek-ai/dsh-e2b'
  config:
    workspace: /home/user/project
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `apiKey` | 省略 | 每次控制平面调用使用的 E2B API 密钥明文；覆盖凭据存储 |
| `apiKeyEnv` | `E2B_API_KEY` | 解析密钥所用的凭据引用名，依次经 `ctx.credentials` 与进程环境 |
| `domain` | SDK 默认 | E2B 控制平面域名 |
| `template` | SDK 默认 | 传给每次创建的沙箱模板名称或 ID |
| `timeoutMs` | SDK 默认 | 沙箱存活时长，1000–86,400,000 毫秒；同时发送给 connect 与 resume |
| `requestTimeoutMs` | SDK 默认 | 每次控制平面调用的截止时限，1000–2,147,483,647 毫秒 |
| `workspace` | 必填 | `initWorkspace` 创建的绝对沙箱目录 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-e2b)是每个受支持字段的穷尽式真源。密钥缺失时，首次生命周期调用会失败并给出 `apiKeyEnv` 变量名；插件加载或释放时不发起任何请求。

### 在设置中配置连接

除 `workspace` 外的每个字段都是 volatile 的，因此组合了 [E2B 设置卡片](../../../packages/client/ui-settings-e2b/README.zh.md)的部署可以在插件页设置密钥、命名该密钥的引用名、模板与两个超时，而不必改 profile 文件。`workspace` 保持普通字段：它属于部署身份，由 preset 拥有。

密钥从不出现在设置响应里。`apiKey` 是 `role('secret')` 普通字段，因此设置服务把它排除在表单之外，并在任何出现处做脱敏；卡片通过凭据域写入密钥，目标是 `apiKeyEnv` 引用名。每次控制平面调用都按以下顺序重新解析密钥——`apiKey` 明文，然后 `ctx.credentials.resolve(apiKeyEnv)`，最后进程环境——这正是卡片里写入的密钥无需重启就能作用于下一次 `create` 的原因。

```yaml
# cordis.yml, with the key left to the credentials store
- id: e2b
  name: '@deepseek-ai/dsh-e2b'
  config:
    apiKeyEnv: E2B_API_KEY
    workspace: /home/user
```

### 驱动生命周期

| 操作 | 作用 |
|---|---|
| `create` | 创建沙箱并持有它直到 `destroy` |
| `connect` | 按 ID 接管已有沙箱；暂停的沙箱会恢复为运行中 |
| `pause` | 暂停被持有的沙箱，保留其文件系统与内存 |
| `resume` | 重新连接并恢复被持有的暂停沙箱 |
| `destroy` | 终止被持有的沙箱并释放它 |
| `initWorkspace` | 在运行中的沙箱内创建配置的工作区目录 |

每个操作都进入同一条队列，因此并发调用方绝不会交错推进状态转换。被拒绝的操作保持持有关系不变，并把其消息记录进 `status()`；随后的成功会清除该消息。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释连接如何实现上述行为；可观测约定由[使用本包](#use-this-package)覆盖。

### 设计

- **单一串行持有者。** 一条 promise 队列严格按顺序运行 create、connect、pause、resume、destroy 与工作区初始化，在下一个操作开始前先接受上一个结果。本地状态机按 `absent → starting → ready → paused` 推进，`failed` 记录最近一次操作的消息，并由下一次成功清除。
- **密钥与时限解析。** 每次调用解析 `apiKey`（缺失时回退到 `apiKeyEnv` 环境变量），并构建全新的连接选项，携带解析出的密钥、配置的域名、`requestTimeoutMs` 与调用方的 `AbortSignal`，因此密钥不会在调用之外被缓存，取消也能传到 SDK 请求。
- **取消的歧义。** 被中止的 create 可能留下 E2B 已经启动的沙箱；连接记录该失败，绝不重连去确认它，被遗留的沙箱随创建时发送的 `timeoutMs` 到期。
- **释放即脱离。** 释放只清除本地句柄与状态，不发起 API 调用，因此应用拆卸绝不阻塞在网络上，远端沙箱只存活到其有界生命周期结束。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`E2bConnection`、配置 schema、状态类型、`Context.e2b` 声明 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [E2B 子系统](../../../docs/subsystems/e2b.zh.md)——配置、生命周期语义与生成的服务 API。
- [E2B 组地图](../README.zh.md)——`packages/e2b/` 下的各包。
- [生成的配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-e2b)——每个受支持配置字段及其源声明。
- [提供方移除决策](../../../.agents/notes/implemented/simplification/2026-09-11-remove-e2b-providers.zh.md)——早期 E2B 提供方家族为何被移除，以及未来提供方必须满足的条件。

-----

<a id="model-experience"></a>
## 模型体验

无，因为 API 密钥、沙箱标识与生命周期转换都是私有部署细节，所有面向模型的操作都由消费方拥有。

#### KV Cache 影响

本连接不贡献请求前缀内容；在提示词中呈现沙箱状态或结果的消费方自行拥有其 token 影响。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

以下限制描述该连接的当前范围；它们是本包约束，不是任务积压。

- **仅生命周期**——本连接自身不拥有任何执行能力；消费它的是 `dsh-fs-e2b` 与 `dsh-subprocess-e2b` 这两个提供方，组合配置仍可直接读取 `ctx.e2b.sandbox`。
- **设置卡片是可选接线**——无论是否组合 Web 客户端页面，`e2b` 命名空间都存在于设置服务中；只靠 profile 配置的部署不会挂载该卡片。
- **每份组合配置一个沙箱**——并行沙箱需要各自独立的组合配置，因为被占用的连接会拒绝第二个持有者。
- **不重连也不重放**——丢失或被中止的控制平面调用会记为失败且绝不重试；被中止的 create 可能留下无法再访问的沙箱，只有其有界生命周期会将其清除。
- **仅本地状态**——`status()` 只读本地内存、绝不探测 E2B，因此远端漂移（手工删除或 E2B 侧到期）会在下一次操作时暴露，而不会出现在状态里。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本包未发布不变式伴随程序。单一串行持有者在本地记录每次生命周期转换，E2B 控制平面是唯一的外部观察者；本包没有第二个可供伴随程序比较的独立观察。[提供方移除决策](../../../.agents/notes/implemented/simplification/2026-09-11-remove-e2b-providers.zh.md)记录了本设计必须持续满足的保留、取消与重连条件。

</details>
