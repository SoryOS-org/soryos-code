---
description: "e2b 组地图：每份组合配置一个由部署方选定的 E2B 远端沙箱，面向浏览本组的用户与维护者。"
kind: "package-group"
---

# e2b/ — E2B 远端沙箱连接

[English](README.md) | 中文

## 概述

e2b 组为在 E2B 隔离虚拟机内执行、而 Harness、模型传输与 Session 存储留在主机的组合配置提供一个由部署方选定的远端沙箱。`e2b` 拥有沙箱生命周期——创建、按 ID 接管、暂停、恢复、销毁与工作区初始化——由一条队列串行推进，消费方从 `ctx.e2b` 读取沙箱句柄。`fs-e2b` 在沙箱工作区之上提供 `ctx.fs`，`subprocess-e2b` 为沙箱内的命令与终端提供 `ctx.subprocess`，让文件与进程共享同一个远端世界。当远端隔离重要时选择本组；主机沙箱后端无需远端机器即可限制本地工作。

## 目录

- [各包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 各包

| 包 | 职责 | 服务 |
|---|---|---|
| [`e2b`](e2b/README.zh.md) | 远端沙箱生命周期：创建、接管、暂停、恢复、销毁与工作区设置 | `ctx.e2b` |
| [`fs-e2b`](fs-e2b/README.zh.md) | 沙箱工作区上的文件系统提供方 | `ctx.fs` |
| [`subprocess-e2b`](subprocess-e2b/README.zh.md) | 子进程提供方：沙箱内的命令与终端 | `ctx.subprocess` |

-----

<a id="related-documentation"></a>
## 相关文档

- [E2B 子系统](../../docs/subsystems/e2b.zh.md)——配置、生命周期语义与生成的服务 API。
- [提供方移除决策](../../.agents/notes/implemented/simplification/2026-09-11-remove-e2b-providers.zh.md)——早期 E2B 提供方家族为何被移除，以及重新引入必须满足的条件。

-----

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
