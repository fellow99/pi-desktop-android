// android-pnpm — pi-agent 扩展工厂（本工程新增能力，规划 §11；ark 未有）
//
// 形态：进程内 vendored pnpm（vendor/pnpm.cjs 9.15.9，MIT）——不做 PATH shim、
// 不 spawn node（Android 无 node 可执行文件；execPath 是 app_process，ark §2.3 同款事实）。
// 执行路径见 lib/runner.mjs；输出直落 app.log（不劫持），工具返回结构化事实。
//
// 纪律（规划 §11.1）：
//  · 生命周期脚本**默认禁用**（--ignore-scripts 恒注入；scripts:true 会被结构化拒绝）——
//    spawn 受限是平台事实，绝不假装「装完了但脚本没跑」；
//  · PI_OFFLINE=1 ⇒ 写操作（install/add/remove）降级为结构化离线拒绝，只读面（list/why/store）保留；
//  · 工作目录围栏：项目必须落在 PI_ANDROID_ROOTS/PI_HOS_ROOTS 声明根内（与 harmony-git fence 同源契约）。
import { runPnpm, assertBundlePresent, PNPM_VERSION_BUNDLED } from './lib/runner.mjs';
import { existsSync } from 'node:fs';
import path from 'node:path';

/** 根清单（两个变量名都认：Android 原生 PI_ANDROID_ROOTS + 单源围栏别名 PI_HOS_ROOTS）。 */
function workspaceRoots() {
  for (const key of ['PI_ANDROID_ROOTS', 'PI_HOS_ROOTS']) {
    const raw = process.env[key];
    if (!raw) continue;
    try {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) return arr.filter((r) => r && typeof r.path === 'string');
    } catch { /* 下一个 */ }
  }
  return [];
}

function isWithinRoots(dir, roots) {
  if (roots.length === 0) return true; // 未声明根 ⇒ 不设围栏（与 harmony-git fence 口径一致）
  const target = path.resolve(dir);
  return roots.some((r) => {
    const base = path.resolve(String(r.path)).replace(/[\\/]+$/, '');
    return target === base || target.startsWith(base + '/') || target.startsWith(base + '\\');
  });
}

/** 组装 CLI 参数：写操作恒注入 --ignore-scripts；store 固定 <HOME>/pnpm-store。 */
function buildArgs(args, { readOnly = false } = {}) {
  const full = [...args];
  if (!readOnly && full.length > 0 && ['add', 'install', 'i', 'remove', 'rm', 'uninstall', 'update'].includes(full[0])
    && !full.includes('--ignore-scripts')) {
    full.splice(1, 0, '--ignore-scripts');
  }
  const home = process.env.HOME || '';
  if (home && !full.some((a) => a === '--store-dir')) {
    full.push('--store-dir', path.join(home, 'pnpm-store'));
  }
  return full;
}

function ok(text, details = {}) {
  return { content: [{ type: 'text', text }], details };
}

function fail(text, details = {}) {
  return { content: [{ type: 'text', text }], details, isError: true };
}

/**
 * 统一执行壳：围栏 + 离线闸 + runPnpm + 结构化返回（输出本身直落 app.log，不搬运）。
 * @param artifacts C1：写操作的产物断言（相对项目目录）；传入后完成判据以产物落盘为准，
 *                  规避本环境 pnpm bundle exit 信号不落地（R8-1），并默认走 silent（不污染主日志）。
 */
async function executePnpm(toolName, args, { readOnly = false, allowOutsideRoot = false, artifacts = null } = {}, ctx) {
  try {
    assertBundlePresent();
    const cwd = ctx?.cwd || process.cwd();
    if (!allowOutsideRoot && !isWithinRoots(cwd, workspaceRoots())) {
      return fail(`${toolName} 拒绝：项目目录不在工作区根内（PI_ANDROID_ROOTS 围栏，规划 §11.1）：${cwd}`);
    }
    if (process.env.PI_OFFLINE === '1' && !readOnly) {
      return fail(`${toolName} 拒绝：PI_OFFLINE=1（离线模式只读面=list/why/store_status；规划 §11.1）`);
    }
    const full = buildArgs(args, { readOnly });
    // C1：有产物断言 ⇒ silent（输出仅在失败时带尾部）+ 以产物为完成判据；无断言维持原 tee 行为
    const { code, ms, output, artifacts: artStatus, artifactSatisfied, via } = await runPnpm(full, {
      cwd,
      timeoutMs: readOnly ? 60_000 : 180_000,
      silent: !!artifacts,
      expectArtifacts: artifacts || [],
    });
    const judgedByArtifacts = !!artifacts;
    const success = code === 0 && (!judgedByArtifacts || artifactSatisfied);
    const head = success
      ? `✓ pnpm ${args.join(' ')}（完成${via === 'artifacts' ? '·产物断言' : `·exit 0`}，${ms}ms）`
      : `✗ pnpm ${args.join(' ')}（exit ${code}，${ms}ms${judgedByArtifacts ? `，产物未齐：${JSON.stringify(artStatus)}` : ''}）`;
    const text = success
      ? `${head}\n完成判据：${judgedByArtifacts ? `产物落盘（${artifacts.map((a) => (typeof a === 'string' ? a : a.path)).join('、')}）；输出静默，不落主日志` : 'exit 0；输出直落 app.log'}。策略：--ignore-scripts 恒注入；bundle=${PNPM_VERSION_BUNDLED}`
      : `${head}\n输出尾部：\n${String(output || '').replace(/\s+/g, ' ').slice(-800)}`;
    const result = success ? ok(text, { code, ms, args: full }) : fail(text, { code, ms, args: full, artifacts: artStatus });
    return result;
  } catch (e) {
    return fail(`pnpm ${toolName} 失败：${(e && e.message) || e}`);
  }
}

function toolDef(name, description, parameters, run) {
  return {
    name,
    label: name,
    description,
    promptSnippet: description,
    parameters,
    executionMode: 'sequential',
    async execute(_id, params, _signal, _onUpdate, ctx) {
      return run(params, ctx);
    },
  };
}

const projectDir = (params, ctx) => params?.dir || ctx?.cwd || process.cwd();

export default function register(pi) {
  const tools = [
    toolDef('pnpm_install', '安装项目依赖（等价 pnpm install；--ignore-scripts 恒注入——依赖生命周期脚本的包会不完整，结果如实以 exit code 为准）', {
      type: 'object',
      properties: { dir: { type: 'string', description: '项目目录（默认会话当前目录）' } },
    }, (params, ctx) => executePnpm('pnpm_install', ['install'], {
      // C1：完成判据 = lockfile 落盘（空依赖项目不建 node_modules/.modules.yaml，故以 lockfile 为准），脱离不可靠 exit
      artifacts: ['pnpm-lock.yaml'],
    }, { ...ctx, cwd: projectDir(params, ctx) })),

    toolDef('pnpm_add', '添加依赖（pnpm add <pkg…>；--ignore-scripts 恒注入——需要脚本的包在设备上不可完整安装，规划 §11.1）', {
      type: 'object',
      properties: {
        dir: { type: 'string', description: '项目目录（默认会话当前目录）' },
        packages: { type: 'array', items: { type: 'string' }, description: '包名（可带版本 range）' },
        dev: { type: 'boolean', description: '作为 devDependencies' },
      },
      required: ['packages'],
    }, (params, ctx) => {
      if (params.scripts === true) {
        return fail('scripts:true 不支持：设备 spawn 受限，生命周期脚本不可执行（规划 §11.1）——需要脚本的包请如实记录「设备上不可完整安装」');
      }
      const args = ['add'];
      if (params.dev) args.push('--save-dev');
      args.push(...params.packages.map(String));
      // C1：产物断言 = lockfile 落盘（包目录名随包名/版本变化，lockfile 是稳定的 add 完成标志）
      return executePnpm('pnpm_add', args, { artifacts: ['pnpm-lock.yaml'] }, { ...ctx, cwd: projectDir(params, ctx) });
    }),

    toolDef('pnpm_remove', '移除依赖（pnpm remove）', {
      type: 'object',
      properties: {
        dir: { type: 'string', description: '项目目录' },
        packages: { type: 'array', items: { type: 'string' } },
      },
      required: ['packages'],
    }, (params, ctx) => executePnpm('pnpm_remove', ['remove', ...params.packages.map(String)], {}, { ...ctx, cwd: projectDir(params, ctx) })),

    toolDef('pnpm_list', '列出项目依赖（pnpm list；只读）', {
      type: 'object',
      properties: { dir: { type: 'string', description: '项目目录' } },
    }, (params, ctx) => executePnpm('pnpm_list', ['list'], { readOnly: true }, { ...ctx, cwd: projectDir(params, ctx) })),

    toolDef('pnpm_why', '解释依赖为何在装（pnpm why <pkg>；只读）', {
      type: 'object',
      properties: { dir: { type: 'string', description: '项目目录' }, package: { type: 'string' } },
      required: ['package'],
    }, (params, ctx) => executePnpm('pnpm_why', ['why', String(params.package)], { readOnly: true }, { ...ctx, cwd: projectDir(params, ctx) })),

    toolDef('pnpm_store_status', '内容寻址 store 状态（pnpm store status；只读；store=<HOME>/pnpm-store，跨项目复用）', {
      type: 'object',
      properties: {},
    }, (_params, ctx) => {
      const home = process.env.HOME || '';
      const store = path.join(home, 'pnpm-store');
      const info = existsSync(store) ? '已存在' : '尚不存在（首次 add/install 创建）';
      const base = executePnpm('pnpm_store_status', ['store', 'status'], { readOnly: true, allowOutsideRoot: true }, ctx);
      base.content[0].text = `store=${store}（${info}）\n` + base.content[0].text;
      return base;
    }),
  ];
  for (const tool of tools) {
    pi.registerTool(tool);
  }
  // 无长驻资源（bundle 按需重入，不持句柄），无需 session_shutdown 清理
}
