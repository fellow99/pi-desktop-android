import * as path from 'node:path';
import * as fsp from 'node:fs/promises';
import { gitRuntime, netFor, rethrowNet, assertNoUserinfo, isAbortError, abortResult } from './ctx.js';
// 目录存在性检查用原生 fs（目标在仓库外，chroot 适配器不适用）

export default {
  name: 'git_clone',
  label: 'Git 克隆',
  description:
    'git clone <url> [dir]：将远端仓库克隆到本地目录（默认取仓库名）。目录必须不存在或为空。需要网络；私有仓库先用 git_credentials set 保存凭据。',
  promptSnippet: '克隆远端仓库。仅支持 http/https；SSH 地址会提示改用 https。',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: '远端仓库地址（http/https）' },
      dir: { type: 'string', description: '目标目录（绝对路径或相对当前目录），默认取 URL 最后一段' },
      ref: { type: 'string', description: '克隆指定分支' },
      depth: { type: 'number', description: '浅克隆深度（如 1）' },
    },
    required: ['url'],
  },
  executionMode: 'sequential',
  async execute(_id, params, _signal, _onUpdate, ctx) {
    try {
      const url = params.url;
      if (!url || !/^https?:\/\//i.test(url)) {
        return { content: [{ type: 'text', text: '仅支持 http/https 克隆地址（SSH 地址请改用 https 形式）。' }], isError: true };
      }
      try { assertNoUserinfo(url); } catch (e) { return { content: [{ type: 'text', text: e.message }], isError: true }; }
      const base = (ctx && ctx.cwd) || process.cwd();
      let dir = params.dir;
      if (!dir) {
        const seg = url.replace(/\/+$/, '').split('/').pop() || 'repo';
        dir = seg.replace(/\.git$/i, '');
      }
      const abs = path.isAbsolute(dir) ? path.normalize(dir) : path.resolve(base, dir);

      // 目标目录须不存在或为空
      let exists = false;
      let nonEmpty = false;
      try {
        const st = await fsp.stat(abs);
        exists = true;
        if (st.isDirectory()) {
          const entries = await fsp.readdir(abs);
          nonEmpty = entries.length > 0;
        } else {
          nonEmpty = true;
        }
      } catch { /* not exists */ }
      if (exists && nonEmpty) {
        return { content: [{ type: 'text', text: `目标目录已存在且非空：${abs}` }], isError: true };
      }
      await fsp.mkdir(abs, { recursive: true });

      const { git } = gitRuntime();
      const net = netFor(abs, url);
      try {
        await git.clone({
          fs: net.fs, http: net.http, dir: abs, url,
          ref: params.ref, depth: params.depth, singleBranch: true, signal: _signal,
          ...net.auth,
        });
      } catch (e) {
        if (isAbortError(e, _signal)) { await fsp.rm(abs, { recursive: true, force: true }).catch(() => {}); return abortResult('git_clone'); }
        // 失败不留半成品目录（否则重试必撞「已存在且非空」）
        await fsp.rm(abs, { recursive: true, force: true }).catch(() => {});
        rethrowNet(e, url);
      }
      let head = null;
      try { head = await git.resolveRef({ fs: net.fs, dir: abs, ref: 'HEAD' }); } catch { /* empty repo */ }
      return {
        content: [{ type: 'text', text: `克隆完成：${url} → ${abs}${head ? `（HEAD ${head.slice(0, 7)}）` : '（空仓库）'}` }],
        details: { ok: true, url, dir: abs, head },
      };
    } catch (e) {
      return { content: [{ type: 'text', text: `git_clone 失败：${e.message}` }], details: { ok: false, message: e.message }, isError: true };
    }
  },
};
