---
description: "面向与 E2B 沙箱内进程共享文件的消费方，说明远端文件系统语义。"
kind: "package-reference"
---

# @deepseek-ai/dsh-fs-e2b

[English](README.md) | 中文

## 概述

`dsh-fs-e2b` 在 [`dsh-e2b`](../e2b/README.zh.md) 拥有的 E2B 沙箱之上提供 `ctx.fs`。文件工具读取和修改的文件与沙箱内进程看到的一致，共处同一个 POSIX 命名空间。路径解析沿符号链接归并到同一身份，版本令牌来自沙箱元数据，写入与编辑按目标串行执行，并沿用本地提供方报告的文件系统错误码。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

将本提供方与它注入为 `ctx.e2b` 的 [`dsh-e2b`](../e2b/README.zh.md) 一同挂载。相对路径以配置的 `cwd` 解析，默认为连接的工作区目录。`diffBasisMaxBytes`（默认 10 MiB）限制覆盖写入为生成上下文 `before` 而读取的既有内容量；更大的文件或二进制文件仍可写入，此时 `before` 为 `null`。

`processPath()` 标识沙箱命名空间中沙箱进程打开的文件，不授予主机侧访问能力。`processPathFromHostPath()` 返回 `undefined`：沙箱内看不到主机可执行文件与引导文件，需要它们的消费方必须显式将它们放入沙箱。`resolve()` 沿用本地提供方的 `FsErrorCode` 报告缺失目标、非目录与权限失败；取消信号在 SDK 调用之前或之间使操作以 `FS_ABORTED` 拒绝。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部 — 点击展开</summary>

`resolve()` 沿符号链接解析，别名共享同一目标身份；解析在 40 跳链接后放弃，与 POSIX 单次查找的上限一致。版本令牌来自沙箱条目的修改时间、大小与模式。写入与编辑按目标持有 FIFO 锁，贯穿读取、过期版本检查与发布，因此并发变更的顺序是确定的：一个成功，其余以过期拒绝。仅当文件为文本且在差异基线上限之内时，覆盖写入才读取既有字节；文本保留文件原有的换行符，流式读取按共享的 UTF-8 与二进制规则增量解码。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [文件系统子系统](../../../docs/subsystems/filesystem.zh.md) — 共享操作与错误含义。
- [E2B 子系统](../../../docs/subsystems/e2b.zh.md) — 连接生命周期与工作区初始化。

-----

<a id="model-experience"></a>
## 模型体验

间接地通过既有文件系统消费方：它们呈现沙箱路径与文件内容，同时拥有全部工具与提示。

#### KV Cache 影响

本提供方不贡献任何请求前缀内容。其消费方拥有面向模型的工具与结果。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- 不支持文件系统监视：提供方没有 `watch()` 覆盖，因此基础的 `FS_IO_ERROR` 拒绝生效。读取与消费方自主的手动刷新仍可用。
- 主机文件不共享：`processPathFromHostPath()` 返回 `undefined`，文件 URL 是沙箱坐标，不是主机句柄或 Web 下载链接。
- 版本令牌来自沙箱元数据：同一毫秒内以相同大小与模式重写的文件可能被读作未变化，从而通过过期版本检查。
- 提供方由基于 fixture 的单元测试覆盖；实机沙箱端到端覆盖需要携带密钥的真实 E2B 部署。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

不发布 invariant 伴随检查。文件系统 seam 与 E2B 连接拥有可观察义务；除以 fixture 重放的 SDK 调用外，本提供方不新增独立观察的状态关系。

</details>
