# E2B 沙箱连接

[English](e2b.md) | 中文

[E2B 连接](../../packages/e2b/e2b/README.zh.md)为每份组合配置持有单个远端沙箱：创建它、按 ID 接管已有沙箱、暂停并恢复它、销毁它，并初始化其工作区目录。只有生命周期操作会联系 E2B 控制平面，每次调用都携带部署方 API 密钥与配置的请求截止时限；插件加载或释放时不发起任何请求。操作一次只运行一个、排在同一条队列中，因此 `status()` 始终只报告一种本地状态——`absent`、`starting`、`ready`、`paused` 或 `failed`——并附带最近一次失败消息。消费方从 `ctx.e2b.sandbox` 读取 SDK 句柄并直接使用其文件系统操作。

源码：[`packages/e2b/e2b/src/index.ts`](../../packages/e2b/e2b/src/index.ts)

## 配置

```ts type-equiv
/** Deployment-owned E2B coordinates; no model argument selects these values. */
interface Config {
  /** E2B API key for every control-plane call; absent reads apiKeyEnv from the process environment. */
  apiKey?: string
  /** Environment variable read for the E2B API key when apiKey is absent. */
  apiKeyEnv: string
  /** E2B control-plane domain; absent uses the SDK default domain. */
  domain?: string
  /** Sandbox template name or ID passed to every create. */
  template?: string
  /** Sandbox lifetime in milliseconds passed to create, connect, and resume, at most 86,400,000 (24 hours). */
  timeoutMs?: number
  /** Control-plane request deadline in milliseconds passed to every E2B API call. */
  requestTimeoutMs?: number
  /** Absolute sandbox directory created by initWorkspace. */
  workspace: string
}
```

加载器在插件挂载前校验配置：`workspace` 必填，`timeoutMs` 取值 1,000 至 86,400,000 毫秒，`requestTimeoutMs` 取值 1,000 至 2,147,483,647 毫秒。`apiKey` 标记为机密并覆盖 `apiKeyEnv`（默认 `E2B_API_KEY`）；密钥缺失或为空时，首次生命周期调用会失败并给出环境变量名。每次调用都重新解析密钥，并构建携带配置域名、请求截止时限与调用方取消信号的全新选项。

## 生命周期

每个操作都进入同一条 promise 队列，只在前一个操作按成功或失败结算后才开始，因此并发调用方无法交错推进状态转换。`create` 与 `connect` 要求连接未持有沙箱；第二个持有者会被拒绝并给出已持有沙箱的 ID，空沙箱 ID 在任何请求前即被拒绝。

本地状态为 `absent`、`starting`、`ready`、`paused` 与 `failed`。成功的操作清除已记录的失败；被拒绝的操作保持持有关系不变，并把其消息记录进 `status()`。被中止的控制平面调用可能留下 E2B 已经启动的沙箱——连接绝不重连去确认它，被遗留的沙箱随创建时发送的 `timeoutMs` 到期。

`initWorkspace` 要求沙箱处于 `ready`，并递归创建配置的目录，已存在的目录保留不动。`destroy` 先终止被持有的沙箱再释放它；被拒绝的终止会保持沙箱仍被持有并记录该失败。

释放只丢弃本地句柄与状态、不发起 API 调用，因此应用拆卸绝不会阻塞在网络上；此后远端沙箱只存活到其有界生命周期结束。

## 连接 API

```ts public-api
/**
 * One E2B connection: it serializes create, connect, pause, resume, and destroy,
 * and drops local ownership at disposal without killing the remote sandbox.
 */
declare class E2bConnection extends Service {
  /** Loader defaults, bounds, and the secret key field for this connection. */
  static Config: schema<Config>;
  constructor(ctx: Context, config: Config);
  /** Current lifecycle state, read from local memory. */
  get state(): E2bState;
  /** Absolute workspace directory every session in this connection starts from. */
  get workspace(): string;
  /** SDK handle of the owned sandbox; throws while this connection owns none. */
  get sandbox(): Sandbox;
  /**
     * Local lifecycle snapshot.
     * @returns state, the owned sandbox ID when one is owned, and the last failure message.
     */
  status(): E2bStatus;
  /**
     * Create a new sandbox and own it until destroy.
     * @param signal - cancels the control-plane request; a rejected create leaves this connection failed without a sandbox.
     * @returns the running sandbox handle.
     */
  async create(signal?: AbortSignal): Promise<Sandbox>;
  /**
     * Own an existing sandbox by ID; a paused sandbox resumes to running.
     * @param sandboxId - ID reported by a previous create or status.
     * @param signal - cancels the control-plane request; a rejected connect leaves this connection failed without a sandbox.
     * @returns the running sandbox handle.
     */
  async connect(sandboxId: string, signal?: AbortSignal): Promise<Sandbox>;
  /**
     * Pause the owned sandbox, keeping its filesystem and memory for a later resume.
     * @param signal - cancels the control-plane request; a rejected pause keeps the current state and records the failure.
     * @returns a promise that settles once E2B reports the pause settled.
     */
  async pause(signal?: AbortSignal): Promise<void>;
  /**
     * Reconnect and resume the owned paused sandbox to running; a ready sandbox is a no-op.
     * @param signal - cancels the control-plane request; a rejected resume keeps the current state and records the failure.
     * @returns a promise that settles once E2B reports the sandbox running.
     */
  async resume(signal?: AbortSignal): Promise<void>;
  /**
     * Kill the owned sandbox and release it; a sandbox E2B no longer reports is still released.
     * @param signal - cancels the control-plane request; a rejected kill keeps the sandbox owned and records the failure.
     * @returns a promise that settles once the local handle is released.
     */
  async destroy(signal?: AbortSignal): Promise<void>;
  /**
     * Create the configured workspace directory in the running sandbox; an existing directory is kept.
     * @param signal - cancels the filesystem request; a rejected call keeps the connection state unchanged and records the failure.
     * @returns a promise that settles once the directory exists.
     */
  async initWorkspace(signal?: AbortSignal): Promise<void>;
}
```

连接在持有沙箱时通过 `sandbox` getter 暴露 SDK 句柄，未持有时抛出异常。`state` 与 `status()` 只读本地内存、绝不联系 E2B，因此远端漂移——手工删除或 E2B 侧到期——会在下一次操作时暴露，而不会出现在状态里。

## 文件系统提供方

[`dsh-fs-e2b`](../../packages/e2b/fs-e2b/README.zh.md) 与连接一同挂载，在沙箱工作区之上提供 `ctx.fs`，让文件工具与沙箱进程共享同一个文件系统。它注入 `ctx.e2b`：`resolve()` 以及每次读取、写入与编辑都在连接的沙箱上执行，相对路径默认落在工作区目录，SDK 失败映射为本地提供方报告的文件系统错误码。其加载器配置（`cwd`、`diffBasisMaxBytes`）列在[配置目录](../config-catalog.zh.md#deepseek-aidsh-fs-e2b)。

路径身份在同一 POSIX 命名空间内沿符号链接归并，版本来自沙箱元数据，写入与编辑按目标在读取、过期版本检查与发布期间持锁。不支持监视与主机路径映射；其余限制见包 README。

源码：[`packages/e2b/fs-e2b/src/index.ts`](../../packages/e2b/fs-e2b/src/index.ts)

## 子进程提供方

[`dsh-subprocess-e2b`](../../packages/e2b/subprocess-e2b/README.zh.md) 与连接一同挂载，在沙箱之上提供 `ctx.subprocess`，让 shell 命令与交互式终端与文件运行在同一个远端世界里。它注入 `ctx.e2b`：spawn 校验保持同步，而远端状态目录、进程组发布以及 `SIGTERM` 到 `SIGKILL` 的终止阶梯都在连接的沙箱上执行；命令执行中途沙箱消失时，受影响的命令按已结束处理，而不是报错。其加载器配置（`pollMs`）列在[配置目录](../config-catalog.zh.md#deepseek-aidsh-subprocess-e2b)。

命令以流式、收集或溢写方式输出并保持有界保留，终端通过沙箱 PTY 分配并支持调整尺寸与前台进程组检查，`control` 保持缺席，因为该传输不承载 PTC 控制通道。终端活动状态始终报告为未知，因此不活动永远不会回收终端；其余限制见包 README。

源码：[`packages/e2b/subprocess-e2b/src/index.ts`](../../packages/e2b/subprocess-e2b/src/index.ts)

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxe2b--e2bconnection"></a>

### `ctx.e2b` — `E2bConnection`

One E2B connection: it serializes create, connect, pause, resume, and destroy, and drops local ownership at disposal without killing the remote sandbox.

```ts cordis-catalog
/**
 * Local lifecycle snapshot.
 * @returns state, the owned sandbox ID when one is owned, and the last failure message.
 */
status(): E2bStatus

/**
 * Create a new sandbox and own it until destroy.
 * @param signal - cancels the control-plane request; a rejected create leaves this connection failed without a sandbox.
 * @returns the running sandbox handle.
 */
async create(signal?: AbortSignal): Promise<Sandbox>

/**
 * Own an existing sandbox by ID; a paused sandbox resumes to running.
 * @param sandboxId - ID reported by a previous create or status.
 * @param signal - cancels the control-plane request; a rejected connect leaves this connection failed without a sandbox.
 * @returns the running sandbox handle.
 */
async connect(sandboxId: string, signal?: AbortSignal): Promise<Sandbox>

/**
 * Pause the owned sandbox, keeping its filesystem and memory for a later resume.
 * @param signal - cancels the control-plane request; a rejected pause keeps the current state and records the failure.
 * @returns a promise that settles once E2B reports the pause settled.
 */
async pause(signal?: AbortSignal): Promise<void>

/**
 * Reconnect and resume the owned paused sandbox to running; a ready sandbox is a no-op.
 * @param signal - cancels the control-plane request; a rejected resume keeps the current state and records the failure.
 * @returns a promise that settles once E2B reports the sandbox running.
 */
async resume(signal?: AbortSignal): Promise<void>

/**
 * Kill the owned sandbox and release it; a sandbox E2B no longer reports is still released.
 * @param signal - cancels the control-plane request; a rejected kill keeps the sandbox owned and records the failure.
 * @returns a promise that settles once the local handle is released.
 */
async destroy(signal?: AbortSignal): Promise<void>

/**
 * Create the configured workspace directory in the running sandbox; an existing directory is kept.
 * @param signal - cancels the filesystem request; a rejected call keeps the connection state unchanged and records the failure.
 * @returns a promise that settles once the directory exists.
 */
async initWorkspace(signal?: AbortSignal): Promise<void>
```

Source: [`packages/e2b/e2b/src/index.ts`](../../packages/e2b/e2b/src/index.ts)
<!-- END GENERATED cordis-surface -->
